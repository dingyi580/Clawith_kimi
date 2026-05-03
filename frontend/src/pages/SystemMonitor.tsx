import { useCallback, useEffect, useRef, useState } from 'react';
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

type HistoryPoint = {
    t: number;
    cpu: number;
    mem: number;
    net_up: number;
    net_dn: number;
    io_r: number;
    io_w: number;
};

type HistoryResponse = {
    range: string;
    granularity: string;
    points: HistoryPoint[];
};

const MAX_HISTORY = 450; // 15 minutes at 2s interval for realtime ring buffer

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

function fmtTime(ts: number): string {
    const d = new Date(ts * 1000);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
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

/* ────── MiniChart (Canvas) ────── */

type SeriesConfig = {
    key: keyof HistoryPoint;
    color: string;
    label: string;
};

function MiniChart({
    history,
    series,
    height = 120,
    fixedMax,
    formatValue,
    showTimeLabels = true,
}: {
    history: HistoryPoint[];
    series: SeriesConfig[];
    height?: number;
    fixedMax?: number;
    formatValue?: (v: number) => string;
    showTimeLabels?: boolean;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container || history.length < 2) return;

        const dpr = window.devicePixelRatio || 1;
        const w = container.clientWidth;
        const h = height;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);

        const padTop = 8;
        const padBottom = 20;
        const padLeft = 44; // space for Y axis
        const padRight = 8;
        const chartW = w - padLeft - padRight;
        const chartH = h - padTop - padBottom;

        // Compute y-axis max
        let yMax = fixedMax ?? 0;
        if (!fixedMax) {
            for (const pt of history) {
                for (const s of series) {
                    const v = pt[s.key] as number;
                    if (v > yMax) yMax = v;
                }
            }
            yMax = yMax * 1.15 || 1; // 15% headroom
        }

        const fmt = formatValue || ((v: number) => v.toFixed(1));

        // Draw grid lines and Y axis labels
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        const lines = 4;
        for (let i = 0; i <= lines; i++) {
            const y = padTop + chartH - (chartH * i) / lines;
            const val = (yMax * i) / lines;
            
            // Draw text
            ctx.fillText(fmt(val), padLeft - 6, y);
            
            // Draw line
            ctx.beginPath();
            ctx.moveTo(padLeft, y);
            ctx.lineTo(padLeft + chartW, y);
            ctx.stroke();
        }

        // Draw time labels (X axis)
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        if (showTimeLabels && history.length > 0) {
            const labelCount = Math.min(5, history.length);
            for (let i = 0; i < labelCount; i++) {
                const idx = Math.floor((i / (labelCount - 1)) * (history.length - 1));
                const x = padLeft + (idx / (history.length - 1)) * chartW;
                
                // If the dataset covers more than a few minutes, use absolute time
                const firstT = history[0].t;
                const lastT = history[history.length - 1].t;
                const durationSpan = lastT - firstT;
                
                let labelStr = '';
                if (durationSpan > 3600 * 24) {
                    // > 1 day
                    const d = new Date(history[idx].t * 1000);
                    labelStr = `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
                } else if (durationSpan > 1800) {
                    // > 30 mins
                    labelStr = fmtTime(history[idx].t);
                } else {
                    // relative seconds
                    const ago = Math.round(lastT - history[idx].t);
                    labelStr = ago === 0 ? 'now' : `-${ago}s`;
                }
                
                ctx.fillText(labelStr, x, h - 2);
            }
        }

        // Draw each series
        for (const s of series) {
            const points: [number, number][] = history.map((pt, i) => {
                const x = padLeft + (i / (history.length - 1)) * chartW;
                const v = pt[s.key] as number;
                const y = padTop + chartH - (v / yMax) * chartH;
                return [x, y];
            });

            // Gradient fill
            const grad = ctx.createLinearGradient(0, padTop, 0, padTop + chartH);
            const baseColor = s.color;
            grad.addColorStop(0, baseColor + '30');
            grad.addColorStop(1, baseColor + '00');

            ctx.beginPath();
            ctx.moveTo(points[0][0], padTop + chartH);
            for (let i = 0; i < points.length; i++) {
                if (i === 0) {
                    ctx.lineTo(points[i][0], points[i][1]);
                } else {
                    // Smooth curve using quadratic bezier
                    const prev = points[i - 1];
                    const curr = points[i];
                    const cpx = (prev[0] + curr[0]) / 2;
                    ctx.quadraticCurveTo(prev[0], prev[1], cpx, (prev[1] + curr[1]) / 2);
                    if (i === points.length - 1) {
                        ctx.quadraticCurveTo(cpx, (prev[1] + curr[1]) / 2, curr[0], curr[1]);
                    }
                }
            }
            ctx.lineTo(points[points.length - 1][0], padTop + chartH);
            ctx.closePath();
            ctx.fillStyle = grad;
            ctx.fill();

            // Line stroke
            ctx.beginPath();
            for (let i = 0; i < points.length; i++) {
                if (i === 0) {
                    ctx.moveTo(points[i][0], points[i][1]);
                } else {
                    const prev = points[i - 1];
                    const curr = points[i];
                    const cpx = (prev[0] + curr[0]) / 2;
                    ctx.quadraticCurveTo(prev[0], prev[1], cpx, (prev[1] + curr[1]) / 2);
                    if (i === points.length - 1) {
                        ctx.quadraticCurveTo(cpx, (prev[1] + curr[1]) / 2, curr[0], curr[1]);
                    }
                }
            }
            ctx.strokeStyle = baseColor;
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // End dot
            const last = points[points.length - 1];
            ctx.beginPath();
            ctx.arc(last[0], last[1], 3, 0, Math.PI * 2);
            ctx.fillStyle = baseColor;
            ctx.fill();
        }
    }, [history, series, height, fixedMax, formatValue, showTimeLabels]);

    useEffect(() => {
        draw();
    }, [draw]);

    useEffect(() => {
        const obs = new ResizeObserver(() => draw());
        if (containerRef.current) obs.observe(containerRef.current);
        return () => obs.disconnect();
    }, [draw]);

    // Legend with current values
    const lastPt = history[history.length - 1];
    const fmt = formatValue || ((v: number) => v.toFixed(1));

    return (
        <div ref={containerRef} style={{ width: '100%' }}>
            <div style={{ display: 'flex', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
                {series.map(s => (
                    <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, display: 'inline-block' }} />
                        <span style={{ color: 'var(--text-tertiary)' }}>{s.label}</span>
                        <span style={{ color: s.color, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                            {lastPt ? fmt(lastPt[s.key] as number) : '—'}
                        </span>
                    </div>
                ))}
            </div>
            <canvas ref={canvasRef} style={{ display: 'block', width: '100%' }} />
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
    
    // Realtime ring buffer (in-memory)
    const historyRef = useRef<HistoryPoint[]>([]);
    const [historyVersion, setHistoryVersion] = useState(0);

    // Historical data options
    const [historyRange, setHistoryRange] = useState<string>('24h');
    const [historyGranularity, setHistoryGranularity] = useState<string>('1m');

    // 1. Live stats polling
    const { data, error, isLoading } = useQuery<SystemMetrics>({
        queryKey: ['system-metrics'],
        queryFn: () => fetchJson<SystemMetrics>('/system/metrics'),
        refetchInterval: 2000,
        refetchIntervalInBackground: false,
    });

    // 2. Historical stats fetching
    const { data: historyData, isLoading: historyLoading } = useQuery<HistoryResponse>({
        queryKey: ['system-metrics-history', historyRange, historyGranularity],
        queryFn: () => fetchJson<HistoryResponse>(`/system/metrics/history?range=${historyRange}&granularity=${historyGranularity}`),
        refetchInterval: 60000, // refresh history every minute
    });

    useEffect(() => {
        if (!data) return;
        const t1 = Date.now();
        let curRates = { ioRead: 0, ioWrite: 0, netUp: 0, netDn: 0 };
        if (lastFrame.current) {
            const dt = (t1 - lastFrame.current.t) / 1000;
            if (dt > 0) {
                curRates = {
                    ioRead: Math.max(0, (data.disk_io.read_bytes - lastFrame.current.readBytes) / dt),
                    ioWrite: Math.max(0, (data.disk_io.write_bytes - lastFrame.current.writeBytes) / dt),
                    netUp: Math.max(0, (data.net.bytes_sent - lastFrame.current.netSent) / dt),
                    netDn: Math.max(0, (data.net.bytes_recv - lastFrame.current.netRecv) / dt),
                };
                setRates(curRates);
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

        // Push to history ring buffer
        const pt: HistoryPoint = {
            t: t1 / 1000, // Unix timestamp (s)
            cpu: data.cpu.total,
            mem: data.memory.percent,
            net_up: curRates.netUp,
            net_dn: curRates.netDn,
            io_r: curRates.ioRead,
            io_w: curRates.ioWrite,
        };
        historyRef.current.push(pt);
        if (historyRef.current.length > MAX_HISTORY) {
            historyRef.current = historyRef.current.slice(-MAX_HISTORY);
        }
        setHistoryVersion(v => v + 1);
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

    const liveHistory = historyRef.current;
    void historyVersion;

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

            {/* ────── Live Charts (15m buffer) ────── */}
            {liveHistory.length >= 3 && (
                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
                        gap: 14,
                        marginBottom: 14,
                    }}
                >
                    <Card title={t('system.cpuLiveTrend', 'CPU 实时趋势 (15m)')}>
                        <MiniChart
                            history={liveHistory}
                            series={[{ key: 'cpu', color: '#22c55e', label: 'CPU' }]}
                            fixedMax={100}
                            formatValue={v => `${v.toFixed(1)}%`}
                        />
                    </Card>
                    <Card title={t('system.memLiveTrend', '内存实时趋势 (15m)')}>
                        <MiniChart
                            history={liveHistory}
                            series={[{ key: 'mem', color: '#3b82f6', label: 'Memory' }]}
                            fixedMax={100}
                            formatValue={v => `${v.toFixed(1)}%`}
                        />
                    </Card>
                    <Card title={t('system.netLiveTrend', '网络 I/O 实时趋势 (15m)')}>
                        <MiniChart
                            history={liveHistory}
                            series={[
                                { key: 'net_up', color: '#f59e0b', label: '↑ Upload' },
                                { key: 'net_dn', color: '#8b5cf6', label: '↓ Download' },
                            ]}
                            formatValue={v => fmtRate(v)}
                        />
                    </Card>
                    <Card title={t('system.diskLiveTrend', '磁盘 I/O 实时趋势 (15m)')}>
                        <MiniChart
                            history={liveHistory}
                            series={[
                                { key: 'io_r', color: '#06b6d4', label: 'Read' },
                                { key: 'io_w', color: '#ec4899', label: 'Write' },
                            ]}
                            formatValue={v => fmtRate(v)}
                        />
                    </Card>
                </div>
            )}

            {/* Containers */}
            <div className="card" style={{ padding: 14, marginBottom: 14 }}>
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

            {/* ────── Historical Charts (DB Backend) ────── */}
            <div className="card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <h2
                        style={{
                            fontSize: 12,
                            color: 'var(--text-tertiary)',
                            margin: 0,
                            textTransform: 'uppercase',
                            letterSpacing: 1,
                            fontWeight: 600,
                        }}
                    >
                        {t('system.history', '历史监控曲线')}
                    </h2>
                    
                    <div style={{ display: 'flex', gap: 12, fontSize: 13 }}>
                        <div style={{ display: 'flex', gap: 4, background: 'var(--bg-tertiary)', padding: 4, borderRadius: 6 }}>
                            {['15m', '1h', '24h', '7d', '30d'].map(r => (
                                <button
                                    key={r}
                                    onClick={() => setHistoryRange(r)}
                                    style={{
                                        background: historyRange === r ? 'var(--bg-secondary)' : 'transparent',
                                        color: historyRange === r ? 'var(--text-primary)' : 'var(--text-secondary)',
                                        border: 'none',
                                        padding: '4px 8px',
                                        borderRadius: 4,
                                        cursor: 'pointer',
                                    }}
                                >
                                    {r}
                                </button>
                            ))}
                        </div>
                        <div style={{ display: 'flex', gap: 4, background: 'var(--bg-tertiary)', padding: 4, borderRadius: 6 }}>
                            {['2s', '1m'].map(g => (
                                <button
                                    key={g}
                                    onClick={() => setHistoryGranularity(g)}
                                    style={{
                                        background: historyGranularity === g ? 'var(--bg-secondary)' : 'transparent',
                                        color: historyGranularity === g ? 'var(--text-primary)' : 'var(--text-secondary)',
                                        border: 'none',
                                        padding: '4px 8px',
                                        borderRadius: 4,
                                        cursor: 'pointer',
                                    }}
                                >
                                    粒度 {g}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {historyLoading ? (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>Loading history...</div>
                ) : !historyData || historyData.points.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>No historical data available yet.</div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                        <div style={{ width: '100%' }}>
                            <MiniChart
                                history={historyData.points}
                                series={[{ key: 'cpu', color: '#22c55e', label: 'CPU Trend' }]}
                                fixedMax={100}
                                height={200}
                                formatValue={v => `${v.toFixed(1)}%`}
                            />
                        </div>
                        <div style={{ width: '100%' }}>
                            <MiniChart
                                history={historyData.points}
                                series={[{ key: 'mem', color: '#3b82f6', label: 'Memory Trend' }]}
                                fixedMax={100}
                                height={200}
                                formatValue={v => `${v.toFixed(1)}%`}
                            />
                        </div>
                        <div style={{ width: '100%' }}>
                            <MiniChart
                                history={historyData.points}
                                series={[
                                    { key: 'net_up', color: '#f59e0b', label: 'Network ↑' },
                                    { key: 'net_dn', color: '#8b5cf6', label: 'Network ↓' },
                                ]}
                                height={200}
                                formatValue={v => fmtRate(v)}
                            />
                        </div>
                        <div style={{ width: '100%' }}>
                            <MiniChart
                                history={historyData.points}
                                series={[
                                    { key: 'io_r', color: '#06b6d4', label: 'Disk Read' },
                                    { key: 'io_w', color: '#ec4899', label: 'Disk Write' },
                                ]}
                                height={200}
                                formatValue={v => fmtRate(v)}
                            />
                        </div>
                    </div>
                )}
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
