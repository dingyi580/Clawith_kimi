import asyncio
import time
from pathlib import Path
import sqlite3

import psutil
from loguru import logger

from app.config import get_settings

settings = get_settings()
METRICS_DB_PATH = Path(settings.AGENT_DATA_DIR) / "metrics.db"

# Initialize DB
def init_db():
    METRICS_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(METRICS_DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS metrics_fine (
                t INTEGER PRIMARY KEY,
                cpu REAL,
                mem REAL,
                net_up REAL,
                net_dn REAL,
                io_r REAL,
                io_w REAL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS metrics_medium (
                t INTEGER PRIMARY KEY,
                cpu REAL,
                mem REAL,
                net_up REAL,
                net_dn REAL,
                io_r REAL,
                io_w REAL
            )
        """)

init_db()

_last_net = None
_last_io = None
_last_time = None

def _collect_host_rates() -> dict | None:
    global _last_net, _last_io, _last_time
    now = time.time()
    
    cpu = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory().percent
    net = psutil.net_io_counters()
    disk_io = psutil.disk_io_counters()

    res = None
    if _last_time is not None:
        dt = now - _last_time
        if dt > 0:
            net_up = max(0, net.bytes_sent - _last_net.bytes_sent) / dt if net and _last_net else 0
            net_dn = max(0, net.bytes_recv - _last_net.bytes_recv) / dt if net and _last_net else 0
            io_r = max(0, disk_io.read_bytes - _last_io.read_bytes) / dt if disk_io and _last_io else 0
            io_w = max(0, disk_io.write_bytes - _last_io.write_bytes) / dt if disk_io and _last_io else 0
            res = {
                "t": int(now),
                "cpu": float(cpu or 0.0),
                "mem": float(mem),
                "net_up": float(net_up),
                "net_dn": float(net_dn),
                "io_r": float(io_r),
                "io_w": float(io_w)
            }
            
    _last_net = net
    _last_io = disk_io
    _last_time = now
    return res

async def start_metrics_collector():
    """Background daemon to collect system metrics into SQLite."""
    logger.info("[metrics_collector] Starting daemon...")
    
    # Prime psutil
    psutil.cpu_percent(interval=None)
    _collect_host_rates()
    
    last_agg_time = time.time()
    
    while True:
        try:
            await asyncio.sleep(2)
            
            # 1. Collect fine metrics
            pt = _collect_host_rates()
            now = time.time()
            if pt:
                # Use a short-lived synchronous connection; safe for simple inserts in asyncio if extremely fast
                with sqlite3.connect(METRICS_DB_PATH, timeout=5.0) as conn:
                    conn.execute(
                        "INSERT OR IGNORE INTO metrics_fine (t, cpu, mem, net_up, net_dn, io_r, io_w) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (pt["t"], pt["cpu"], pt["mem"], pt["net_up"], pt["net_dn"], pt["io_r"], pt["io_w"])
                    )

            # 2. Every minute, aggregate fine into medium and clean up old data
            if now - last_agg_time >= 60:
                with sqlite3.connect(METRICS_DB_PATH, timeout=5.0) as conn:
                    # Aggregate recent 60 seconds
                    min_t = int(last_agg_time)
                    max_t = int(now)
                    
                    row = conn.execute("""
                        SELECT avg(cpu), avg(mem), avg(net_up), avg(net_dn), avg(io_r), avg(io_w)
                        FROM metrics_fine
                        WHERE t >= ? AND t < ?
                    """, (min_t, max_t)).fetchone()
                    
                    if row and row[0] is not None:
                        conn.execute(
                            "INSERT OR IGNORE INTO metrics_medium (t, cpu, mem, net_up, net_dn, io_r, io_w) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (max_t, *row)
                        )
                    
                    # Cleanup: fine > 7 days (7 * 24 * 3600 = 604800)
                    conn.execute("DELETE FROM metrics_fine WHERE t < ?", (int(now) - 604800,))
                    
                    # Cleanup: medium > 30 days (30 * 24 * 3600 = 2592000)
                    conn.execute("DELETE FROM metrics_medium WHERE t < ?", (int(now) - 2592000,))
                    
                last_agg_time = now

        except Exception as e:
            logger.error(f"[metrics_collector] Error: {e}")
            await asyncio.sleep(5)
