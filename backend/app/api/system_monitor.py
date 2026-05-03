"""System monitor API — host + Docker metrics, any authenticated user."""

import sqlite3
import time
from pathlib import Path
from fastapi import APIRouter, Depends, Query, HTTPException

from app.core.security import get_current_user
from app.services.system_monitor import collect_metrics
from app.config import get_settings

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/metrics", dependencies=[Depends(get_current_user)])
def get_metrics() -> dict:
    """Return a snapshot of host + Docker container metrics.

    Intentionally a sync def — psutil and docker-py are blocking, so FastAPI runs
    this in its threadpool instead of pinning the event loop.
    """
    return collect_metrics()


@router.get("/metrics/history", dependencies=[Depends(get_current_user)])
def get_metrics_history(
    range_str: str = Query("15m", alias="range"),
    granularity: str = Query("2s")
) -> dict:
    """Return historical metrics from SQLite. Downsamples automatically if too many points."""
    now = int(time.time())
    
    # Parse range
    range_map = {"15m": 15*60, "1h": 3600, "24h": 86400, "7d": 7*86400, "30d": 30*86400}
    if range_str not in range_map:
        raise HTTPException(status_code=400, detail="Invalid range")
    time_span = range_map[range_str]
    min_t = now - time_span

    # Parse granularity
    if granularity == "1m":
        table = "metrics_medium"
        base_interval = 60
    elif granularity == "2s":
        table = "metrics_fine"
        base_interval = 2
    else:
        raise HTTPException(status_code=400, detail="Invalid granularity")

    # Limit to max 100000 points to prevent browser freeze, but allow full 24h of 2s data (43200 points)
    max_points = 100000
    effective_interval = max(base_interval, time_span // max_points)
    
    db_path = Path(get_settings().AGENT_DATA_DIR) / "metrics.db"
    if not db_path.exists():
        return {"range": range_str, "granularity": granularity, "points": []}

    try:
        with sqlite3.connect(db_path, timeout=5.0) as conn:
            conn.row_factory = sqlite3.Row
            
            if effective_interval <= base_interval:
                # No extra downsampling needed
                rows = conn.execute(
                    f"SELECT t, cpu, mem, net_up, net_dn, io_r, io_w FROM {table} WHERE t >= ? ORDER BY t ASC",
                    (min_t,)
                ).fetchall()
            else:
                # Downsample using SQLite
                # t / interval * interval gives the bucket start time
                rows = conn.execute(
                    f"""
                    SELECT 
                        (t / ?) * ? as bucket_t,
                        avg(cpu) as cpu, 
                        avg(mem) as mem, 
                        avg(net_up) as net_up, 
                        avg(net_dn) as net_dn, 
                        avg(io_r) as io_r, 
                        avg(io_w) as io_w
                    FROM {table}
                    WHERE t >= ?
                    GROUP BY bucket_t
                    ORDER BY bucket_t ASC
                    """,
                    (effective_interval, effective_interval, min_t)
                ).fetchall()
                
            points = [
                {
                    "t": row["bucket_t"] if effective_interval > base_interval else row["t"],
                    "cpu": row["cpu"],
                    "mem": row["mem"],
                    "net_up": row["net_up"],
                    "net_dn": row["net_dn"],
                    "io_r": row["io_r"],
                    "io_w": row["io_w"],
                }
                for row in rows
            ]
            
            return {"range": range_str, "granularity": granularity, "points": points}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

