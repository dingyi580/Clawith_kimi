"""System monitor — collect host + Docker container metrics for the System Monitor page.

Host metrics come from psutil; the backend container must run with `pid: host` so the
view of /proc reflects the host. Container metrics come from docker-py via the mounted
Docker socket.
"""

from __future__ import annotations

import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import docker
import psutil
from docker.errors import DockerException
from loguru import logger

# psutil.cpu_percent returns 0.0 on its first call after import — prime once at module
# load so the first request from the UI gets a real number.
psutil.cpu_percent(interval=None, percpu=True)
psutil.cpu_percent(interval=None)


def _host_hostname() -> str:
    """Return the host hostname when /host/etc/hostname is mounted, else the container hostname.

    /proc/sys/kernel/hostname always reflects the reader's UTS namespace, even when
    /host/proc is bind-mounted — so we read /host/etc/hostname instead, which carries the
    actual host name.
    """
    try:
        return Path("/host/etc/hostname").read_text().strip() or socket.gethostname()
    except OSError:
        return socket.gethostname()


_docker_client: docker.DockerClient | None = None


def _get_docker_client() -> docker.DockerClient | None:
    """Lazily initialise (and cache) a docker-py client. Returns None when unavailable.

    Failures are NOT cached — the daemon can come up after our process did, and we'd
    rather pay one ping per request than be silently stuck for the rest of the session.
    """
    global _docker_client
    if _docker_client is not None:
        return _docker_client
    try:
        client = docker.from_env(timeout=4)
        client.ping()
    except DockerException as exc:
        logger.debug(f"[system_monitor] docker not available: {exc}")
        return None
    _docker_client = client
    return _docker_client


def _container_stats(container) -> dict[str, Any]:
    """Compute one container's metrics. Runs inside a worker thread."""
    name = container.name
    status = container.status
    entry: dict[str, Any] = {
        "name": name,
        "status": status,
        "cpu_percent": None,
        "mem_used": None,
        "mem_total": None,
        "mem_percent": 0.0,
        "net_rx": None,
        "net_tx": None,
    }
    if status != "running":
        return entry

    try:
        stats = container.stats(stream=False)
    except Exception as exc:
        logger.debug(f"[system_monitor] stats({name}) failed: {exc}")
        return entry

    # CPU%: (container_delta / system_delta) * online_cpus * 100
    try:
        cpu_now = stats["cpu_stats"]["cpu_usage"]["total_usage"]
        cpu_prev = stats["precpu_stats"]["cpu_usage"]["total_usage"]
        sys_now = stats["cpu_stats"].get("system_cpu_usage") or 0
        sys_prev = stats["precpu_stats"].get("system_cpu_usage") or 0
        online = (
            stats["cpu_stats"].get("online_cpus")
            or len(stats["cpu_stats"]["cpu_usage"].get("percpu_usage") or [1])
            or 1
        )
        cpu_d = cpu_now - cpu_prev
        sys_d = sys_now - sys_prev
        entry["cpu_percent"] = (cpu_d / sys_d) * online * 100.0 if cpu_d > 0 and sys_d > 0 else 0.0
    except (KeyError, TypeError, ZeroDivisionError):
        entry["cpu_percent"] = 0.0

    # Memory: usage minus cache, against the cgroup limit
    try:
        mem_stats = stats.get("memory_stats", {}) or {}
        usage = mem_stats.get("usage", 0) or 0
        limit = mem_stats.get("limit", 0) or 0
        sub = mem_stats.get("stats") or {}
        cache = sub.get("cache") or sub.get("inactive_file") or 0
        used = max(usage - cache, 0)
        entry["mem_used"] = used
        entry["mem_total"] = limit
        entry["mem_percent"] = (used / limit * 100.0) if limit > 0 else 0.0
    except (KeyError, TypeError):
        pass

    # Network: sum across all interfaces, cumulative bytes since container start
    try:
        nets = stats.get("networks") or {}
        entry["net_rx"] = sum(int(n.get("rx_bytes", 0) or 0) for n in nets.values())
        entry["net_tx"] = sum(int(n.get("tx_bytes", 0) or 0) for n in nets.values())
    except (TypeError, AttributeError):
        pass

    return entry


def _docker_stats() -> list[dict[str, Any]]:
    """Snapshot all containers in parallel — one stats call per worker thread."""
    client = _get_docker_client()
    if not client:
        return []
    try:
        containers = client.containers.list(all=True)
    except DockerException as exc:
        logger.debug(f"[system_monitor] list containers failed: {exc}")
        return []
    if not containers:
        return []

    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(8, len(containers))) as pool:
        futures = [pool.submit(_container_stats, c) for c in containers]
        for fut in as_completed(futures, timeout=12):
            try:
                results.append(fut.result(timeout=10))
            except Exception as exc:
                logger.debug(f"[system_monitor] stats worker failed: {exc}")
    return sorted(results, key=lambda r: r["name"])


def collect_metrics() -> dict[str, Any]:
    """Return host + Docker container snapshot for the System Monitor page."""
    cpu_cores = psutil.cpu_percent(interval=None, percpu=True)
    cpu_total = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disk = psutil.disk_usage("/")
    disk_io = psutil.disk_io_counters()
    try:
        load = psutil.getloadavg()
    except (AttributeError, OSError):
        load = (0.0, 0.0, 0.0)
    net = psutil.net_io_counters()

    return {
        "host": _host_hostname(),
        "cpu": {"total": float(cpu_total or 0.0), "cores": [float(c) for c in cpu_cores]},
        "memory": {"used": int(mem.used), "total": int(mem.total), "percent": float(mem.percent)},
        "swap": {"used": int(swap.used), "total": int(swap.total), "percent": float(swap.percent)},
        "disk": {"used": int(disk.used), "total": int(disk.total), "percent": float(disk.percent)},
        "disk_io": {
            "read_bytes": int(disk_io.read_bytes) if disk_io else 0,
            "write_bytes": int(disk_io.write_bytes) if disk_io else 0,
        },
        "load": [float(x) for x in load],
        "net": {
            "bytes_sent": int(net.bytes_sent) if net else 0,
            "bytes_recv": int(net.bytes_recv) if net else 0,
        },
        "uptime": float(time.time() - psutil.boot_time()),
        "containers": _docker_stats(),
    }
