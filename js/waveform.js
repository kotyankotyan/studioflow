class WaveformRenderer {
    constructor() {
        this.pixelsPerSecond = 100;
        this.colors = {
            waveform: '#4a9eff',
            waveformBg: '#0d1b2a',
            clip: 'rgba(74, 158, 255, 0.15)',
            clipBorder: 'rgba(74, 158, 255, 0.4)',
            selection: 'rgba(233, 69, 96, 0.2)',
            grid: 'rgba(255,255,255,0.05)',
            playhead: '#e94560'
        };
    }

    drawWaveform(canvas, buffer, options = {}) {
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();

        const cssWidth  = rect.width  || canvas.offsetWidth  || canvas.parentElement?.offsetWidth  || 300;
        const cssHeight = rect.height || canvas.offsetHeight || canvas.parentElement?.offsetHeight || 64;

        const MAX_CANVAS_PX = 16384;
        const effectiveDpr = Math.min(dpr, MAX_CANVAS_PX / Math.max(cssWidth, cssHeight, 1));

        canvas.width  = Math.round(cssWidth  * effectiveDpr);
        canvas.height = Math.round(cssHeight * effectiveDpr);
        ctx.scale(effectiveDpr, effectiveDpr);

        const width  = cssWidth;
        const height = cssHeight;
        const color = options.color || this.colors.waveform;

        ctx.clearRect(0, 0, width, height);

        if (!buffer) return;

        const data = buffer.getChannelData(0);
        const step = Math.ceil(data.length / width);
        const amp = height / 2;

        ctx.fillStyle = color;
        ctx.globalAlpha = 0.8;

        for (let i = 0; i < width; i++) {
            const start = Math.floor(i * step);
            let min = 1.0, max = -1.0;
            for (let j = 0; j < step && start + j < data.length; j++) {
                const datum = data[start + j];
                if (datum < min) min = datum;
                if (datum > max) max = datum;
            }
            const yMin = (1 + min) * amp;
            const yMax = (1 + max) * amp;
            ctx.fillRect(i, yMax, 1, yMin - yMax || 1);
        }

        ctx.globalAlpha = 0.3;
        for (let i = 0; i < width; i++) {
            const start = Math.floor(i * step);
            let rms = 0;
            let count = 0;
            for (let j = 0; j < step && start + j < data.length; j++) {
                rms += data[start + j] * data[start + j];
                count++;
            }
            rms = Math.sqrt(rms / count);
            const h = rms * height * 0.8;
            ctx.fillRect(i, amp - h / 2, 1, h);
        }

        ctx.globalAlpha = 1;
    }

    drawClipWaveform(canvas, buffer, clipStart, clipDuration, zoom = 1) {
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();

        // getBoundingClientRect が 0 を返す場合（display:none の親など）は
        // offsetWidth / parentElement / 固定値でフォールバック
        const cssWidth  = rect.width  || canvas.offsetWidth  || canvas.parentElement?.offsetWidth  || canvas.parentElement?.clientWidth  || 300;
        const cssHeight = rect.height || canvas.offsetHeight || canvas.parentElement?.offsetHeight || canvas.parentElement?.clientHeight || 64;

        // ブラウザのCanvas最大サイズ（32767px）を超えないようにDPRを自動調整
        const MAX_CANVAS_PX = 16384;
        const effectiveDpr = Math.min(dpr, MAX_CANVAS_PX / Math.max(cssWidth, cssHeight, 1));

        canvas.width  = Math.round(cssWidth  * effectiveDpr);
        canvas.height = Math.round(cssHeight * effectiveDpr);
        ctx.scale(effectiveDpr, effectiveDpr);

        const width  = cssWidth;
        const height = cssHeight;

        ctx.clearRect(0, 0, width, height);

        if (!buffer) return;

        // 背景
        ctx.fillStyle = 'rgba(13, 27, 42, 1)';
        ctx.fillRect(0, 0, width, height);

        const data = buffer.getChannelData(0);
        const sampleRate = buffer.sampleRate;
        const startSample = Math.floor((clipStart || 0) * sampleRate);
        const endSample = Math.min(
            startSample + Math.floor((clipDuration || buffer.duration) * sampleRate),
            data.length
        );
        const totalSamples = endSample - startSample;
        const step = Math.max(1, Math.ceil(totalSamples / width));
        const amp = height / 2;

        // 明るいグラジェントで視認性を高める
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0,   'rgba(100, 180, 255, 0.85)');
        gradient.addColorStop(0.5, 'rgba(74,  158, 255, 1.0)');
        gradient.addColorStop(1,   'rgba(100, 180, 255, 0.85)');
        ctx.fillStyle = gradient;

        for (let i = 0; i < width; i++) {
            const idx = startSample + Math.floor(i * totalSamples / width);
            let min = 1.0, max = -1.0;
            for (let j = 0; j < step && idx + j < endSample; j++) {
                const datum = data[idx + j];
                if (datum < min) min = datum;
                if (datum > max) max = datum;
            }
            const yMin = (1 + min) * amp;
            const yMax = (1 + max) * amp;
            ctx.fillRect(i, yMax, 1, Math.max(1, yMin - yMax));
        }

        // 中心線
        ctx.strokeStyle = 'rgba(74, 158, 255, 0.25)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, amp);
        ctx.lineTo(width, amp);
        ctx.stroke();
    }

    drawRuler(canvas, duration, pixelsPerSecond, offset = 0) {
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();

        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        const width = rect.width;
        const height = rect.height;

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#16213e';
        ctx.fillRect(0, 0, width, height);

        const startTime = offset / pixelsPerSecond;
        const endTime = startTime + width / pixelsPerSecond;

        let interval = 1;
        if (pixelsPerSecond < 20) interval = 10;
        else if (pixelsPerSecond < 50) interval = 5;
        else if (pixelsPerSecond < 100) interval = 2;
        else if (pixelsPerSecond > 200) interval = 0.5;

        ctx.fillStyle = '#a0a0b0';
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.strokeStyle = '#3a4a6a';

        const firstMark = Math.floor(startTime / interval) * interval;
        for (let t = firstMark; t <= endTime; t += interval) {
            const x = (t - startTime) * pixelsPerSecond;

            ctx.beginPath();
            ctx.moveTo(x, height - 10);
            ctx.lineTo(x, height);
            ctx.stroke();

            const minutes = Math.floor(t / 60);
            const seconds = Math.floor(t % 60);
            const label = `${minutes}:${String(seconds).padStart(2, '0')}`;
            ctx.fillText(label, x, height - 14);

            for (let sub = 1; sub < 4; sub++) {
                const subX = x + (sub * interval / 4) * pixelsPerSecond;
                ctx.beginPath();
                ctx.moveTo(subX, height - 5);
                ctx.lineTo(subX, height);
                ctx.strokeStyle = '#2a3a5a';
                ctx.stroke();
                ctx.strokeStyle = '#3a4a6a';
            }
        }
    }

    drawMeter(canvas, level, peak = false) {
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#0d1b2a';
        ctx.fillRect(0, 0, width, height);

        const meterHeight = level * height;
        const gradient = ctx.createLinearGradient(0, height, 0, 0);
        gradient.addColorStop(0, '#22c55e');
        gradient.addColorStop(0.6, '#eab308');
        gradient.addColorStop(0.85, '#e94560');

        ctx.fillStyle = gradient;
        ctx.fillRect(0, height - meterHeight, width, meterHeight);

        for (let y = 0; y < height; y += 4) {
            ctx.fillStyle = '#0d1b2a';
            ctx.fillRect(0, y, width, 1);
        }
    }
}

window.WaveformRenderer = WaveformRenderer;
