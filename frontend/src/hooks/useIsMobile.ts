import { useState, useEffect } from 'react';

export function useIsMobile(breakpoint = 768) {
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        
        const mql = window.matchMedia(`(max-width: ${breakpoint}px)`);
        const onChange = () => setIsMobile(mql.matches);
        
        // Initial check
        onChange();
        
        // Listen for changes
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, [breakpoint]);

    return isMobile;
}
