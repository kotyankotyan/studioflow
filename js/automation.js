class AutomationManager {
    constructor() {
        this.automationData = new Map();
        this.canvas = null;
        this.ctx = null;
        this.selectedTrackId = null;
        this.selectedParam = 'volume';
        this.points = [];
        this.isDragging = false;
        this.dragPointIndex = -1;
        this.pixelsPerSecond = 100;
        this.duration = 60;
    }

    init(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this._setupEvents();
        this.draw();
    }

    _setupEvents() {
        this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
        this.canvas.addEventListener('mouseup', () => this._onMouseUp());
        this.canvas.addEventListener('dblclick', (e) => this._onDoubleClick(e));
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this._onRightClick(e);
        });
    }

    setTrack(trackId) {
        this.selectedTrackId = trackId;
        this._loadPoints();
        this.draw();
    }

    setParam(param) {
        this.selectedParam = param;
        this._loadPoints();
        this.draw();
    }

    _getKey() {
        return `${this.selectedTrackId}_${this.selectedParam}`;
    }

    _loadPoints() {
        const key = this._getKey();
        this.points = this.automationData.get(key) || [];
    }

    _savePoints() {
        const key = this._getKey();
        this.automationData.set(key, [...this.points]);
    }

    _getCanvasPos(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }

    _timeToX(time) {
        return time * this.pixelsPerSecond;
    }

    _xToTime(x) {
        return x / this.pixelsPerSecond;
    }

    _valueToY(value) {
        const h = this.canvas.getBoundingClientRect().height;
        return h - (value * h);
    }

    _yToValue(y) {
        const h = this.canvas.getBoundingClientRect().height;
        return Math.max(0, Math.min(1, 1 - y / h));
    }

    _onMouseDown(e) {
        const pos = this._getCanvasPos(e);
        const nearIdx = this._findNearPoint(pos.x, pos.y);

        if (nearIdx >= 0) {
            this.isDragging = true;
            this.dragPointIndex = nearIdx;
        } else {
            const time = this._xToTime(pos.x);
            const value = this._yToValue(pos.y);
            this._addPoint(time, value);
            this.isDragging = true;
            this.dragPointIndex = this.points.length - 1;
        }
    }

    _onMouseMove(e) {
        if (!this.isDragging || this.dragPointIndex < 0) return;
        const pos = this._getCanvasPos(e);
        const time = Math.max(0, this._xToTime(pos.x));
        const value = this._yToValue(pos.y);

        this.points[this.dragPointIndex] = { time, value };
        this.points.sort((a, b) => a.time - b.time);
        this.dragPointIndex = this.points.findIndex(p => p.time === time && p.value === value);
        this._savePoints();
        this.draw();
    }

    _onMouseUp() {
        this.isDragging = false;
        this.dragPointIndex = -1;
    }

    _onDoubleClick(e) {
        const pos = this._getCanvasPos(e);
        const nearIdx = this._findNearPoint(pos.x, pos.y);
        if (nearIdx >= 0) {
            this.points.splice(nearIdx, 1);
            this._savePoints();
            this.draw();
        }
    }

    _onRightClick(e) {
        const pos = this._getCanvasPos(e);
        const nearIdx = this._findNearPoint(pos.x, pos.y);
        if (nearIdx >= 0) {
            this.points.splice(nearIdx, 1);
            this._savePoints();
            this.draw();
        }
    }

    _findNearPoint(x, y, threshold = 10) {
        for (let i = 0; i < this.points.length; i++) {
            const px = this._timeToX(this.points[i].time);
            const py = this._valueToY(this.points[i].value);
            const dist = Math.sqrt((px - x) ** 2 + (py - y) ** 2);
            if (dist < threshold) return i;
        }
        return -1;
    }

    _addPoint(time, value) {
        this.points.push({ time, value });
        this.points.sort((a, b) => a.time - b.time);
        this._savePoints();
        this.draw();
    }

    clearPoints() {
        this.points = [];
        this._savePoints();
        this.draw();
    }

    smoothPoints() {
        if (this.points.length < 3) return;

        const smoothed = this.points.map((p, i) => {
            if (i === 0 || i === this.points.length - 1) return p;
            const prev = this.points[i - 1];
            const next = this.points[i + 1];
            return {
                time: p.time,
                value: (prev.value + p.value * 2 + next.value) / 4
            };
        });

        this.points = smoothed;
        this._savePoints();
        this.draw();
    }

    getValueAtTime(trackId, param, time) {
        const key = `${trackId}_${param}`;
        const points = this.automationData.get(key) || [];

        if (points.length === 0) return this._getDefaultValue(param);
        if (time <= points[0].time) return points[0].value;
        if (time >= points[points.length - 1].time) return points[points.length - 1].value;

        for (let i = 0; i < points.length - 1; i++) {
            if (time >= points[i].time && time <= points[i + 1].time) {
                const t = (time - points[i].time) / (points[i + 1].time - points[i].time);
                return points[i].value + t * (points[i + 1].value - points[i].value);
            }
        }

        return this._getDefaultValue(param);
    }

    _getDefaultValue(param) {
        switch (param) {
            case 'volume': return 0.8;
            case 'pan': return 0.5;
            case 'filter': return 1;
            default: return 0.5;
        }
    }

    draw() {
        if (!this.canvas || !this.ctx) return;

        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.scale(dpr, dpr);

        const w = rect.width;
        const h = rect.height;

        this.ctx.fillStyle = '#1e2a4a';
        this.ctx.fillRect(0, 0, w, h);

        this.ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        this.ctx.lineWidth = 1;
        for (let i = 0; i <= 10; i++) {
            const y = (i / 10) * h;
            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(w, y);
            this.ctx.stroke();
        }

        for (let t = 0; t < this.duration; t++) {
            const x = this._timeToX(t);
            if (x > w) break;
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, h);
            this.ctx.stroke();
        }

        if (this.points.length > 0) {
            this.ctx.strokeStyle = '#22c55e';
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();

            const startX = this._timeToX(this.points[0].time);
            const startY = this._valueToY(this.points[0].value);
            this.ctx.moveTo(startX, startY);

            for (let i = 1; i < this.points.length; i++) {
                const x = this._timeToX(this.points[i].time);
                const y = this._valueToY(this.points[i].value);
                this.ctx.lineTo(x, y);
            }
            this.ctx.stroke();

            const gradient = this.ctx.createLinearGradient(0, 0, 0, h);
            gradient.addColorStop(0, 'rgba(34, 197, 94, 0.2)');
            gradient.addColorStop(1, 'rgba(34, 197, 94, 0)');

            this.ctx.fillStyle = gradient;
            this.ctx.beginPath();
            this.ctx.moveTo(this._timeToX(this.points[0].time), h);
            this.ctx.lineTo(this._timeToX(this.points[0].time), this._valueToY(this.points[0].value));
            for (let i = 1; i < this.points.length; i++) {
                this.ctx.lineTo(this._timeToX(this.points[i].time), this._valueToY(this.points[i].value));
            }
            this.ctx.lineTo(this._timeToX(this.points[this.points.length - 1].time), h);
            this.ctx.closePath();
            this.ctx.fill();

            this.points.forEach((p, i) => {
                const x = this._timeToX(p.time);
                const y = this._valueToY(p.value);

                this.ctx.fillStyle = i === this.dragPointIndex ? '#e94560' : '#22c55e';
                this.ctx.beginPath();
                this.ctx.arc(x, y, 5, 0, Math.PI * 2);
                this.ctx.fill();

                this.ctx.strokeStyle = 'white';
                this.ctx.lineWidth = 1.5;
                this.ctx.stroke();
            });
        }

        this.ctx.fillStyle = 'rgba(255,255,255,0.3)';
        this.ctx.font = '10px Inter, sans-serif';
        this.ctx.textAlign = 'left';

        const paramLabels = {
            volume: '音量', pan: 'パン', 'eq-low': 'EQ Low',
            'eq-mid': 'EQ Mid', 'eq-high': 'EQ High',
            reverb: 'リバーブ', filter: 'フィルター'
        };
        this.ctx.fillText(paramLabels[this.selectedParam] || this.selectedParam, 8, 16);

        if (!this.selectedTrackId) {
            this.ctx.fillStyle = 'rgba(255,255,255,0.2)';
            this.ctx.font = '14px Inter, sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.fillText('トラックを選択してオートメーションを描画', w / 2, h / 2);
        }
    }
}

window.AutomationManager = AutomationManager;
