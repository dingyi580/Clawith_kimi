import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores';

export default function GlobalMusicPlayer() {
    const token = useAuthStore((s) => s.token);
    const audioRef = useRef<HTMLAudioElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [currentMusicUrl, setCurrentMusicUrl] = useState<string | null>(null);

    // 如果未登录，不渲染播放器球
    if (!token) return null;

    const togglePlay = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (audioRef.current && currentMusicUrl) {
            if (isPlaying) {
                audioRef.current.pause();
                setIsPlaying(false);
            } else {
                audioRef.current.play()
                    .then(() => setIsPlaying(true))
                    .catch(console.error);
            }
        }
    };

    const handleUploadClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (fileInputRef.current) {
            fileInputRef.current.click();
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const url = URL.createObjectURL(file);
            setCurrentMusicUrl(url);
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.src = url;
                audioRef.current.load();
                audioRef.current.play()
                    .then(() => setIsPlaying(true))
                    .catch(console.error);
            }
        }
        // 重置 input，允许重复上传同一个文件
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    return (
        <>
            <style>{`
                @media (max-width: 768px) {
                    .global-music-player {
                        display: none !important;
                    }
                }
            `}</style>
            <div 
                className="global-music-player"
                style={{
                    position: 'fixed',
                    bottom: '24px',
                    right: '24px',
                    zIndex: 9999,
                    backgroundColor: 'var(--bg-secondary, rgba(255, 255, 255, 0.1))',
                    backdropFilter: 'blur(10px)',
                    WebkitBackdropFilter: 'blur(10px)',
                    border: '1px solid var(--border-color, rgba(255, 255, 255, 0.2))',
                    padding: '12px',
                    borderRadius: '24px', // 胶囊形状
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                    width: isHovered ? '88px' : '48px', // hover 时动态展开
                    height: '48px',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    opacity: 0.8,
                    overflow: 'hidden'
                }} 
                onMouseEnter={(e) => {
                    setIsHovered(true);
                    e.currentTarget.style.opacity = '1';
                    e.currentTarget.style.transform = 'translateY(-2px)';
                    e.currentTarget.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.2)';
                }}
                onMouseLeave={(e) => {
                    setIsHovered(false);
                    e.currentTarget.style.opacity = '0.8';
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
                }}
            >
                {/* 只有在有音源的时候才渲染 audio 的 src */}
                <audio ref={audioRef} src={currentMusicUrl || undefined} loop preload="auto" />
                <input 
                    type="file" 
                    ref={fileInputRef} 
                    onChange={handleFileChange} 
                    accept="audio/*" 
                    style={{ display: 'none' }} 
                />
                
                {/* 播放/暂停按钮 */}
                <div 
                    onClick={togglePlay}
                    style={{ 
                        cursor: currentMusicUrl ? 'pointer' : 'not-allowed',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '24px',
                        height: '24px',
                        flexShrink: 0,
                        opacity: currentMusicUrl ? 1 : 0.5
                    }}
                    title={!currentMusicUrl ? "请先上传音乐" : (isPlaying ? "暂停音乐" : "播放音乐")}
                >
                    {isPlaying ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--text-primary, #ffffff)">
                            <rect x="6" y="4" width="4" height="16" rx="1" />
                            <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                    ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--text-primary, #ffffff)">
                            <path d="M6 4l15 8-15 8z" />
                        </svg>
                    )}
                </div>

                {/* 上传音乐按钮 */}
                <div 
                    onClick={handleUploadClick}
                    style={{
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '24px',
                        height: '24px',
                        flexShrink: 0,
                        opacity: isHovered ? 1 : 0,
                        transform: isHovered ? 'scale(1)' : 'scale(0.8)',
                        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                        pointerEvents: isHovered ? 'auto' : 'none'
                    }}
                    title="上传本地音乐"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary, #ffffff)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="17 8 12 3 7 8"></polyline>
                        <line x1="12" y1="3" x2="12" y2="15"></line>
                    </svg>
                </div>
            </div>
        </>
    );
}
