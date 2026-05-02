import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { agentApi, activityApi } from '../services/api';
import { IconMessageCircle, IconPlus } from '@tabler/icons-react';
import { useIsMobile } from '../hooks/useIsMobile';
import type { Agent } from '../types';

/* ── Helpers ── */

const STATUS_DOT_COLOR: Record<string, string> = {
    running: 'var(--status-running, #22c55e)',
    idle: 'var(--status-idle, #a3a3a3)',
    stopped: 'var(--status-stopped, #71717a)',
    error: 'var(--status-error, #ef4444)',
    creating: 'var(--text-tertiary, #a1a1aa)',
};

function timeAgo(dateStr: string | undefined, t: any): string {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('dashboard.justNow', 'just now');
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d`;
    return `${Math.floor(days / 30)}mo`;
}

export default function MobileAgentList() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const isMobile = useIsMobile();

    const currentTenant = localStorage.getItem('current_tenant_id') || '';

    const { data: agents = [], isLoading } = useQuery<Agent[]>({
        queryKey: ['agents', currentTenant],
        queryFn: () => agentApi.list(currentTenant || undefined),
        refetchInterval: 15000,
    });

    // Fetch latest activity summary per agent
    const [latestActivities, setLatestActivities] = useState<Record<string, string>>({});

    useEffect(() => {
        if (agents.length === 0) return;
        const fetchActivities = async () => {
            const result: Record<string, string> = {};
            const results = await Promise.allSettled(
                agents.map(a => activityApi.list(a.id, 1))
            );
            results.forEach((r, i) => {
                if (r.status === 'fulfilled' && r.value.length > 0) {
                    result[agents[i].id] = r.value[0].summary || '';
                }
            });
            setLatestActivities(result);
        };
        fetchActivities();
        const interval = setInterval(fetchActivities, 30000);
        return () => clearInterval(interval);
    }, [agents.map(a => a.id).join(',')]);

    // Sort: running first, then by last_active_at desc
    const sortedAgents = [...agents].sort((a, b) => {
        const aActive = a.status === 'running' || a.status === 'idle' ? 1 : 0;
        const bActive = b.status === 'running' || b.status === 'idle' ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aTime = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
        const bTime = b.last_active_at ? new Date(b.last_active_at).getTime() : 0;
        return bTime - aTime;
    });

    if (!isMobile) {
        return <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)' }}>This page is for mobile devices only.</div>;
    }

    return (
        <div style={{ padding: '16px', paddingBottom: '80px' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h1 style={{ fontSize: '24px', margin: 0, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {t('nav.agents', 'Agents')}
                </h1>
                <button
                    onClick={() => navigate('/agents/new')}
                    className="btn btn-primary"
                    style={{ width: '36px', height: '36px', padding: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                    <IconPlus size={20} stroke={2} />
                </button>
            </div>

            {/* Content */}
            {isLoading ? (
                <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-tertiary)', fontSize: '14px' }}>
                    {t('common.loading', 'Loading...')}
                </div>
            ) : agents.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-tertiary)' }}>
                    <IconMessageCircle size={40} stroke={1} style={{ opacity: 0.3, marginBottom: '12px' }} />
                    <div style={{ fontSize: '15px', marginBottom: '16px' }}>{t('dashboard.noAgents', 'No agents yet')}</div>
                    <button className="btn btn-primary" onClick={() => navigate('/agents/new')} style={{ fontSize: '14px' }}>
                        <IconPlus size={16} stroke={2} style={{ marginRight: '6px' }} />
                        {t('nav.newAgent', 'New Agent')}
                    </button>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    {sortedAgents.map((agent) => {
                        const unread = agent.unread_count || 0;
                        const lastActivity = latestActivities[agent.id] || agent.role_description || '';
                        const statusColor = STATUS_DOT_COLOR[agent.status] || 'var(--text-tertiary)';
                        const isOnline = agent.status === 'running' || agent.status === 'idle';

                        return (
                            <div
                                key={agent.id}
                                onClick={() => navigate(`/agents/${agent.id}/chat`)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    padding: '14px 12px',
                                    borderRadius: '12px',
                                    cursor: 'pointer',
                                    transition: 'background 0.12s',
                                }}
                            >
                                {/* Avatar with status dot */}
                                <div style={{ position: 'relative', marginRight: '14px', flexShrink: 0 }}>
                                    <div style={{
                                        width: '48px', height: '48px', borderRadius: '14px',
                                        background: 'var(--bg-tertiary)',
                                        border: '1px solid var(--border-subtle)',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        fontSize: '22px',
                                        color: 'var(--text-secondary)',
                                    }}>
                                        {agent.avatar_url
                                            ? <img src={agent.avatar_url} alt="" style={{ width: '100%', height: '100%', borderRadius: '14px', objectFit: 'cover' }} />
                                            : '🤖'}
                                    </div>
                                    {/* Status indicator */}
                                    <span style={{
                                        position: 'absolute', bottom: '-1px', right: '-1px',
                                        width: '12px', height: '12px', borderRadius: '50%',
                                        background: statusColor,
                                        border: '2px solid var(--bg-primary)',
                                        boxShadow: isOnline ? `0 0 0 1px ${statusColor}40` : 'none',
                                    }} />
                                </div>

                                {/* Name + last activity */}
                                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                                    <div style={{
                                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                        marginBottom: '4px',
                                    }}>
                                        <span style={{
                                            fontWeight: 600, fontSize: '15px', color: 'var(--text-primary)',
                                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                        }}>
                                            {agent.name}
                                        </span>
                                        <span style={{
                                            fontSize: '12px', color: 'var(--text-tertiary)',
                                            flexShrink: 0, marginLeft: '8px',
                                        }}>
                                            {timeAgo(agent.last_active_at, t)}
                                        </span>
                                    </div>
                                    <div style={{
                                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                    }}>
                                        <span style={{
                                            fontSize: '13px', color: 'var(--text-tertiary)',
                                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                            flex: 1,
                                        }}>
                                            {lastActivity || '—'}
                                        </span>
                                        {unread > 0 && (
                                            <span style={{
                                                flexShrink: 0, marginLeft: '8px',
                                                minWidth: '20px', height: '20px',
                                                borderRadius: '10px', padding: '0 6px',
                                                background: 'var(--error, #ef4444)',
                                                color: '#fff',
                                                fontSize: '11px', fontWeight: 700,
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                lineHeight: 1,
                                            }}>
                                                {unread > 99 ? '99+' : unread}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
