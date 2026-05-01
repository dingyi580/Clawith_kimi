import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchJson } from '../services/api';

/* ────── Types ────── */

type ContainerInfo = {
    name: string;
    status: string;
    cpu_percent: number | null;
    mem_used: number | null;
    mem_total: number | null;
    mem_percent: number;
    net_rx: number | null;
    net_tx: number | null;
};

type SystemMetrics = {
    host: string;
    cpu: { total: number; cores: number[] };
    memory: { used: number; total: number; percent: number };
    swap: { used: number; total: number; percent: number };
    disk: { used: number; total: number; percent: number };
    disk_io: { read_bytes: number; write_bytes: number };
    load: number[];
    net: { bytes_sent: number; bytes_recv: number };
    uptime: number;
    containers: ContainerInfo[];
};

/* ────── Formatters ────── */

function fmtBytes(n: number | null | undefined): string {
    if (n == null || !isFinite(n) || n < 0) return '—';
    if (n < 1024) return `${n.toFixed(0)} B`;
    if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(1)} MB`;
    return `${(n / 1_073_741_824).toFixed(2)} GB`;
}

function fmtRate(n: number): string {
    return `${fmtBytes(n)}/s`;
}

function fmtUptime(s: number): string {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

/* ────── Visual primitives ────── */

function thresholdColor(pct: number): string {
    if (pct >= 90) return 'var(--error)';
    if (pct >= 70) return 'var(--warning)';
    return 'var(--success)';
}

function Bar({ pct }: { pct: number }) {
    const clamped = Math.max(0, Math.min(100, pct || 0));
    return (
        <div
            style={{
                background: 'var(--bg-tertiary)',
                height: 6,
                borderRadius: 3,
                marginTop: 6,
                overflow: 'hidden',
            }}
        >
            <div
                style={{
                    width: `${clamped}%`,
                    height: '100%',
                    background: thresholdColor(clamped),
                    transition: 'width .4s ease, background .4s ease',
                }}
            />
        </div>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div
            style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '3px 0',
                fontSize: 13,
            }}
        >
            <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
            <span style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                {value}
            </span>
        </div>
    );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="card" style={{ padding: 14 }}>
            <h2
                style={{
                    fontSize: 12,
                    color: 'var(--text-tertiary)',
                    margin: 0,
                    marginBottom: 10,
                    textTransform: 'uppercase',
                    letterSpacing: 1,
                    fontWeight: 600,
                }}
            >
                {title}
            </h2>
            {children}
        </div>
    );
}

function CoreChip({ index, pct }: { index: number; pct: number }) {
    const bg =
        pct >= 90
            ? 'rgba(244, 67, 54, 0.18)'
            : pct >= 70
                ? 'rgba(255, 152, 0, 0.18)'
                : 'var(--bg-tertiary)';
    const fg =
        pct >= 90 ? 'var(--error)' : pct >= 70 ? 'var(--warning)' : 'var(--text-primary)';
    return (
        <div
            style={{
                flex: 1,
                minWidth: 38,
                textAlign: 'center',
                fontSize: 10,
                color: 'var(--text-tertiary)',
                background: bg,
                borderRadius: 4,
                padding: '4px 2px',
            }}
        >
            {index}
            <span
                style={{
                    display: 'block',
                    color: fg,
                    fontSize: 11,
                    marginTop: 2,
                    fontVariantNumeric: 'tabular-nums',
                }}
            >
                {pct.toFixed(0)}%
            </span>
        </div>
    );
}

/* ────── Main page ────── */

type Frame = { t: number; readBytes: number; writeBytes: number; netSent: number; netRecv: number };

export default function SystemMonitor() {
    const { t } = useTranslation();
    const [now, setNow] = useState(() => Date.now());
    const lastFrame = useRef<Frame | null>(null);
    const [rates, setRates] = useState<{ ioRead: number; ioWrite: number; netUp: number; netDn: number } | null>(null);

    const { data, error, isLoading } = useQuery<SystemMetrics>({
        queryKey: ['system-metrics'],
        queryFn: () => fetchJson<SystemMetrics>('/system/metrics'),
        refetchInterval: 2000,
        refetchIntervalInBackground: false,
    });

    useEffect(() => {
        if (!data) return;
        const t1 = Date.now();
        if (lastFrame.current) {
            const dt = (t1 - lastFrame.current.t) / 1000;
            if (dt > 0) {
                setRates({
                    ioRead: Math.max(0, (data.disk_io.read_bytes - lastFrame.current.readBytes) / dt),
                    ioWrite: Math.max(0, (data.disk_io.write_bytes - lastFrame.current.writeBytes) / dt),
                    netUp: Math.max(0, (data.net.bytes_sent - lastFrame.current.netSent) / dt),
                    netDn: Math.max(0, (data.net.bytes_recv - lastFrame.current.netRecv) / dt),
                });
            }
        }
        lastFrame.current = {
            t: t1,
            readBytes: data.disk_io.read_bytes,
            writeBytes: data.disk_io.write_bytes,
            netSent: data.net.bytes_sent,
            netRecv: data.net.bytes_recv,
        };
        setNow(t1);
    }, [data]);

    if (isLoading && !data) {
        return (
            <div style={{ padding: 24, color: 'var(--text-tertiary)' }}>
                {t('common.loading', '加载中...')}
            </div>
        );
    }

    if (error && !data) {
        return (
            <div style={{ padding: 24 }}>
                <div
                    style={{
                        color: 'var(--error)',
                        background: 'rgba(244, 67, 54, 0.08)',
                        border: '1px solid rgba(244, 67, 54, 0.3)',
                        borderRadius: 'var(--radius-md, 6px)',
                        padding: 14,
                        fontSize: 13,
                    }}
                >
                    {t('system.refreshError', '采集失败')}: {(error as Error).message}
                </div>
            </div>
        );
    }

    if (!data) return null;

    return (
        <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
            {/* Header */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 12,
                    marginBottom: 20,
                }}
            >
                <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, letterSpacing: '-0.02em' }}>
                    <span
                        style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: 'var(--success)',
                            marginRight: 8,
                            animation: 'pulse 1.5s ease-in-out infinite',
                        }}
                    />
                    {t('system.title', '系统监控')} — {data.host}
                </h1>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                    {t('system.uptime', '运行时长')} {fmtUptime(data.uptime)} ·{' '}
                    {new Date(now).toLocaleTimeString()}
                </div>
            </div>

            {/* Grid */}
            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                    gap: 14,
                    marginBottom: 14,
                }}
            >
                <Card title={t('system.cpu', 'CPU')}>
                    <Row label={t('system.total', 'Total')} value={`${data.cpu.total.toFixed(1)}%`} />
                    <Bar pct={data.cpu.total} />
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 10 }}>
                        {data.cpu.cores.map((v, i) => (
                            <CoreChip key={i} index={i} pct={v} />
                        ))}
                    </div>
                </Card>

                <Card title={t('system.memory', '内存')}>
                    <Row
                        label={t('system.used', 'Used')}
                        value={`${fmtBytes(data.memory.used)} / ${fmtBytes(data.memory.total)} (${data.memory.percent.toFixed(1)}%)`}
                    />
                    <Bar pct={data.memory.percent} />
                    <div style={{ marginTop: 10 }}>
                        <Row
                            label={t('system.swap', 'Swap')}
                            value={
                                data.swap.total > 0
                                    ? `${fmtBytes(data.swap.used)} / ${fmtBytes(data.swap.total)} (${data.swap.percent.toFixed(1)}%)`
                                    : '—'
                            }
                        />
                        <Bar pct={data.swap.percent} />
                    </div>
                </Card>

                <Card title={t('system.disk', '磁盘 (根分区)')}>
                    <Row
                        label={t('system.used', 'Used')}
                        value={`${fmtBytes(data.disk.used)} / ${fmtBytes(data.disk.total)} (${data.disk.percent.toFixed(1)}%)`}
                    />
                    <Bar pct={data.disk.percent} />
                    <div style={{ marginTop: 10 }}>
                        <Row
                            label={t('system.diskRead', 'I/O 读取')}
                            value={rates ? fmtRate(rates.ioRead) : '—'}
                        />
                        <Row
                            label={t('system.diskWrite', 'I/O 写入')}
                            value={rates ? fmtRate(rates.ioWrite) : '—'}
                        />
                    </div>
                </Card>

                <Card title={t('system.loadNet', 'Load & Network')}>
                    <Row label={t('system.load1', 'Load 1m')} value={(data.load[0] ?? 0).toFixed(2)} />
                    <Row label={t('system.load5', 'Load 5m')} value={(data.load[1] ?? 0).toFixed(2)} />
                    <Row label={t('system.load15', 'Load 15m')} value={(data.load[2] ?? 0).toFixed(2)} />
                    <div style={{ marginTop: 10 }}>
                        <Row
                            label={t('system.netUp', 'Net ↑')}
                            value={rates ? fmtRate(rates.netUp) : '—'}
                        />
                        <Row
                            label={t('system.netDn', 'Net ↓')}
                            value={rates ? fmtRate(rates.netDn) : '—'}
                        />
                    </div>
                </Card>
            </div>

            {/* Containers */}
            <div className="card" style={{ padding: 14 }}>
                <h2
                    style={{
                        fontSize: 12,
                        color: 'var(--text-tertiary)',
                        margin: 0,
                        marginBottom: 10,
                        textTransform: 'uppercase',
                        letterSpacing: 1,
                        fontWeight: 600,
                    }}
                >
                    {t('system.containers', 'Docker 容器')}
                </h2>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                            <tr style={{ color: 'var(--text-tertiary)' }}>
                                <th style={cellHead}>{t('system.containerName', '名称')}</th>
                                <th style={cellHead}>{t('system.containerStatus', '状态')}</th>
                                <th style={{ ...cellHead, textAlign: 'right' }}>CPU</th>
                                <th style={{ ...cellHead, textAlign: 'right' }}>
                                    {t('system.memory', '内存')}
                                </th>
                                <th style={{ ...cellHead, textAlign: 'right' }}>Net I/O</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.containers.length === 0 ? (
                                <tr>
                                    <td colSpan={5} style={{ padding: '14px 8px', color: 'var(--text-tertiary)' }}>
                                        —
                                    </td>
                                </tr>
                            ) : (
                                data.containers.map((c) => (
                                    <tr key={c.name}>
                                        <td style={{ ...cell, fontWeight: 500, color: 'var(--text-primary)' }}>
                                            {c.name}
                                        </td>
                                        <td style={{ ...cell, color: containerStatusColor(c.status) }}>
                                            {c.status}
                                        </td>
                                        <td style={{ ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                            {c.cpu_percent != null ? `${c.cpu_percent.toFixed(1)}%` : '—'}
                                        </td>
                                        <td style={{ ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                            {c.mem_used != null
                                                ? `${fmtBytes(c.mem_used)} (${c.mem_percent.toFixed(1)}%)`
                                                : '—'}
                                        </td>
                                        <td style={{ ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                            {c.net_rx != null && c.net_tx != null
                                                ? `${fmtBytes(c.net_rx)} ↓ / ${fmtBytes(c.net_tx)} ↑`
                                                : '—'}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            <style>{`
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }
            `}</style>
        </div>
    );
}

const cellHead: React.CSSProperties = {
    padding: '7px 8px',
    textAlign: 'left',
    borderBottom: '1px solid var(--border-subtle)',
    fontWeight: 600,
    textTransform: 'uppercase',
    fontSize: 10,
    letterSpacing: '.5px',
};

const cell: React.CSSProperties = {
    padding: '7px 8px',
    borderBottom: '1px solid var(--border-subtle)',
    color: 'var(--text-secondary)',
};

function containerStatusColor(s: string): string {
    if (s === 'running') return 'var(--success)';
    if (s === 'exited' || s === 'dead') return 'var(--error)';
    return 'var(--warning)';
}
