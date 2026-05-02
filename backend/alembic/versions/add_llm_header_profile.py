"""Add header_profile column to llm_models table

Revision ID: add_llm_header_profile
Revises: user_refactor_v1
Create Date: 2026-05-02
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'add_llm_header_profile'
down_revision: Union[str, None] = 'merge_pr494_heads'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'llm_models',
        sa.Column('header_profile', sa.String(50), server_default='default', nullable=False),
    )


def downgrade() -> None:
    op.drop_column('llm_models', 'header_profile')
