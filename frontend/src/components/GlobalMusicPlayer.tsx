import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores';
import { enterpriseApi } from '../services/api';

interface Song {
    id: string;
    url: string;
    name: string;
    uploader_name: string;
    created_at: string;
}

export default function GlobalMusicPlayer({ collapsed }: { collapsed?: boolean }) {
    const token = useAuthStore((s) => s.token);
    const user = useAuthStore((s) => s.user);
    const audioRef = useRef<HTMLAudioElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    
    const [isPlaying, setIsPlaying] = useState(false);
    const [isPlaylistOpen, setIsPlaylistOpen] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    
    const [songs, setSongs] = useState<Song[]>([]);
    const [currentIndex, setCurrentIndex] = useState(0);

    const currentSong = songs[currentIndex];
    
    const fetchPlaylist = async () => {
        try {
            const data = await enterpriseApi.playlist();
            setSongs(data.songs || []);
        } catch (e) {
            console.error('Failed to fetch playlist', e);
        }
    };

    // Load playlist on mount
    useEffect(() => {
        if (token) fetchPlaylist();
    }, [token]);

    // Update audio src when current song changes — natively streaming with token in URL
    useEffect(() => {
        if (audioRef.current && currentSong && token) {
            const wasPlaying = !audioRef.current.paused || isPlaying;
            // Append token to URL since backend now accepts it via query parameter
            const streamUrl = `${currentSong.url}&token=${token}`;
            
            audioRef.current.src = streamUrl;
            audioRef.current.load();
            if (wasPlaying) {
                audioRef.current.play().catch(console.error);
            }
        }
    }, [currentSong?.id, token]);

    if (!token) return null;

    const togglePlay = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (audioRef.current && currentSong) {
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

    const handleNext = (e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (songs.length === 0) return;
        setCurrentIndex((prev) => (prev + 1) % songs.length);
        // Ensure it plays if user manually clicked next
        if (!isPlaying && e) {
            setIsPlaying(true);
            setTimeout(() => audioRef.current?.play().catch(console.error), 50);
        }
    };


    const handleUploadClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (fileInputRef.current) {
            fileInputRef.current.click();
        }
    };

    const handleDelete = async (e: React.MouseEvent, songId: string) => {
        e.stopPropagation();
        try {
            await enterpriseApi.playlistDelete(songId);
            await fetchPlaylist();
            if (currentSong?.id === songId) {
                handleNext();
            }
        } catch (error: any) {
            alert(error.message || 'Failed to delete song');
        }
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        
        try {
            setIsUploading(true);
            // 1. Upload file to server
            const uploadRes = await enterpriseApi.playlistUpload(file);
            
            // 2. Add to playlist
            const newSong: Song = {
                id: Math.random().toString(36).substr(2, 9),
                url: uploadRes.url,
                name: file.name.replace(/\.[^/.]+$/, ""), // remove extension
                uploader_name: user?.display_name || user?.username || 'Unknown',
                created_at: new Date().toISOString()
            };
            
            await enterpriseApi.playlistAdd(newSong);
            await fetchPlaylist();
            
            // If it was the first song, start playing it
            if (songs.length === 0) {
                setCurrentIndex(0);
                setIsPlaying(true);
                setTimeout(() => audioRef.current?.play().catch(console.error), 500);
            }
        } catch (error: any) {
            alert('Upload failed: ' + (error.message || 'Unknown error'));
        } finally {
            setIsUploading(false);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        }
    };

    const isAdmin = user?.role === 'platform_admin' || user?.role === 'org_admin';

    const canDelete = (_song: Song) => isAdmin;

    return (
        <>
            <style>{`
                .music-playlist-popover {
                    position: fixed;
                    bottom: 65px;
                    left: 16px;
                    width: 208px;
                    max-height: 300px;
                    background: var(--bg-primary);
                    border: 1px solid var(--border-subtle);
                    border-radius: 8px;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.15);
                    overflow-y: auto;
                    padding: 8px 0;
                    display: flex;
                    flex-direction: column;
                    opacity: 0;
                    transform: translateY(10px);
                    pointer-events: none;
                    transition: all 0.2s ease;
                    z-index: 1000;
                }
                .music-playlist-popover.open {
                    opacity: 1;
                    transform: translateY(0);
                    pointer-events: auto;
                }
                .playlist-item {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 8px 16px;
                    cursor: pointer;
                    transition: background 0.2s;
                }
                .playlist-item:hover {
                    background: var(--bg-tertiary);
                }
                .playlist-item.active {
                    color: var(--brand-color, #10a37f);
                    background: var(--bg-tertiary);
                }
                .playlist-item-info {
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    margin-right: 8px;
                }
                .playlist-item-name {
                    font-size: 13px;
                    font-weight: 500;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .playlist-item-uploader {
                    font-size: 11px;
                    color: var(--text-tertiary);
                    margin-top: 2px;
                }
                .playlist-item-delete {
                    opacity: 0;
                    color: var(--text-tertiary);
                    padding: 4px;
                }
                .playlist-item:hover .playlist-item-delete {
                    opacity: 1;
                }
                .playlist-item-delete:hover {
                    color: #ef4444;
                }
            `}</style>
            <div 
                className="global-music-player sidebar-section"
                style={{
                    position: 'relative',
                    padding: collapsed ? '8px' : '12px 16px',
                    borderTop: '1px solid var(--border-subtle)',
                    marginBottom: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: collapsed ? 'center' : 'stretch',
                    boxSizing: 'border-box',
                    maxWidth: '100%',
                }}
            >
                {/* Playlist Popover */}
                {!collapsed && (
                <div className={`music-playlist-popover ${isPlaylistOpen ? 'open' : ''}`}>
                    <div style={{ padding: '4px 16px 8px', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)', marginBottom: '4px' }}>
                        公司共享歌单 ({songs.length})
                    </div>
                    {songs.length === 0 ? (
                        <div style={{ padding: '16px', textAlign: 'center', fontSize: '13px', color: 'var(--text-tertiary)' }}>
                            暂无音乐，快来上传第一首吧！
                        </div>
                    ) : (
                        songs.map((song, idx) => (
                            <div 
                                key={song.id} 
                                className={`playlist-item ${idx === currentIndex ? 'active' : ''}`}
                                onClick={() => {
                                    setCurrentIndex(idx);
                                    if (!isPlaying) {
                                        setIsPlaying(true);
                                        setTimeout(() => audioRef.current?.play().catch(console.error), 50);
                                    }
                                }}
                            >
                                <div className="playlist-item-info">
                                    <span className="playlist-item-name" title={song.name}>{song.name}</span>
                                    <span className="playlist-item-uploader">上传者: {song.uploader_name}</span>
                                </div>
                                {canDelete(song) && (
                                    <div 
                                        className="playlist-item-delete" 
                                        onClick={(e) => handleDelete(e, song.id)}
                                        title="删除"
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="3 6 5 6 21 6"></polyline>
                                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                        </svg>
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
                )}

                <audio 
                    ref={audioRef}
                    preload="auto" 
                    onEnded={() => handleNext()} 
                />
                <input 
                    type="file" 
                    ref={fileInputRef} 
                    onChange={handleFileChange} 
                    accept="audio/*" 
                    style={{ display: 'none' }} 
                />
                
                {collapsed ? (
                    // Collapsed View
                    <div 
                        onClick={togglePlay}
                        style={{ cursor: currentSong ? 'pointer' : 'not-allowed', color: currentSong ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
                        title={!currentSong ? "暂无音乐" : (isPlaying ? "暂停音乐" : "播放音乐")}
                    >
                        {isPlaying ? (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                <rect x="6" y="4" width="4" height="16" rx="1" />
                                <rect x="14" y="4" width="4" height="16" rx="1" />
                            </svg>
                        ) : (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <polygon points="10 8 16 12 10 16 10 8"></polygon>
                            </svg>
                        )}
                    </div>
                ) : (
                    // Expanded View
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                            <div 
                                onClick={togglePlay}
                                style={{ 
                                    cursor: currentSong ? 'pointer' : 'not-allowed',
                                    color: currentSong ? 'var(--text-primary)' : 'var(--text-tertiary)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                                }}
                                title={!currentSong ? "暂无音乐" : (isPlaying ? "暂停音乐" : "播放音乐")}
                            >
                                {isPlaying ? (
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                        <rect x="6" y="4" width="4" height="16" rx="1" />
                                        <rect x="14" y="4" width="4" height="16" rx="1" />
                                    </svg>
                                ) : (
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="12" cy="12" r="10"></circle>
                                        <polygon points="10 8 16 12 10 16 10 8"></polygon>
                                    </svg>
                                )}
                            </div>
                            
                            <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                                <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {currentSong?.name || "暂无音乐"}
                                </span>
                                <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>
                                    {currentSong ? `上传者: ${currentSong.uploader_name}` : "点击上传添加音乐"}
                                </span>
                            </div>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-tertiary)' }}>
                            <div 
                                onClick={handleNext}
                                style={{ cursor: songs.length > 1 ? 'pointer' : 'not-allowed', display: 'flex', opacity: songs.length > 1 ? 1 : 0.5 }}
                                title="下一首"
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                    <polygon points="5 4 15 12 5 20 5 4"></polygon>
                                    <line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2"></line>
                                </svg>
                            </div>
                            {isAdmin && (
                            <div 
                                onClick={handleUploadClick}
                                style={{ cursor: isUploading ? 'wait' : 'pointer', display: 'flex', opacity: isUploading ? 0.5 : 1 }}
                                title={isUploading ? "上传中..." : "上传共享音乐"}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                    <polyline points="17 8 12 3 7 8"></polyline>
                                    <line x1="12" y1="3" x2="12" y2="15"></line>
                                </svg>
                            </div>
                            )}
                            <div 
                                onClick={(e) => { e.stopPropagation(); setIsPlaylistOpen(!isPlaylistOpen); }}
                                style={{ cursor: 'pointer', display: 'flex', color: isPlaylistOpen ? 'var(--brand-color, #10a37f)' : 'inherit' }}
                                title="查看共享歌单"
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="8" y1="6" x2="21" y2="6"></line>
                                    <line x1="8" y1="12" x2="21" y2="12"></line>
                                    <line x1="8" y1="18" x2="21" y2="18"></line>
                                    <line x1="3" y1="6" x2="3.01" y2="6"></line>
                                    <line x1="3" y1="12" x2="3.01" y2="12"></line>
                                    <line x1="3" y1="18" x2="3.01" y2="18"></line>
                                </svg>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
