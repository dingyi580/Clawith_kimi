"""System monitor API — host + Docker metrics, any authenticated user."""

from fastapi import APIRouter, Depends

from app.core.security import get_current_user
from app.services.system_monitor import collect_metrics

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/metrics", dependencies=[Depends(get_current_user)])
def get_metrics() -> dict:
    """Return a snapshot of host + Docker container metrics.

    Intentionally a sync def — psutil and docker-py are blocking, so FastAPI runs
    this in its threadpool instead of pinning the event loop.
    """
    return collect_metrics()
