
function getInfoLines(dataIdx, units, config) {
  const fd = state.currentFlightData;
  const alt = fd.altitudes[dataIdx];
  const vSpeed = fd.vertSpeeds[dataIdx];
  const t = fd.times[dataIdx];
  const lines = [], colors = [], labels = [];

  if (config.showTime) {
    const sign = t < 0 ? '- ' : '+ ';
    const absT = Math.abs(t);
    const tMin = Math.floor(absT / 60);
    const tSec = Math.floor(absT % 60);
    lines.push(tMin + ':' + tSec.toString().padStart(2, '0'));
    colors.push('#f8fafc');
    labels.push('TIME');
  }

  if (config.showAltitude) {
    if (units === 'metric') lines.push(alt.toFixed(0) + ' m');
    else if (units === 'imperial') lines.push((alt * 3.28084).toFixed(0) + ' ft');
    else lines.push(alt.toFixed(0) + ' m / ' + (alt * 3.28084).toFixed(0) + ' ft');
    colors.push('#f8fafc');
    labels.push('ALTITUDE');
  }

  if (config.showSpeed) {
    if (units === 'metric') lines.push((vSpeed * 3.6).toFixed(0) + ' km/h');
    else if (units === 'imperial') lines.push((vSpeed * 2.23694).toFixed(0) + ' mph');
    else lines.push((vSpeed * 3.6).toFixed(0) + ' km/h / ' + (vSpeed * 2.23694).toFixed(0) + ' mph');
    colors.push('#f8fafc');
    labels.push('VERT. SPEED');
  }

  if (config.showHSpeed) {
    const hSpeed = fd.horzSpeeds[dataIdx];
    if (units === 'metric') lines.push((hSpeed * 3.6).toFixed(0) + ' km/h');
    else if (units === 'imperial') lines.push((hSpeed * 2.23694).toFixed(0) + ' mph');
    else lines.push((hSpeed * 3.6).toFixed(0) + ' km/h / ' + (hSpeed * 2.23694).toFixed(0) + ' mph');
    colors.push('#f8fafc');
    labels.push('HORIZ. SPEED');
  }

  if (config.showDiveAngle && fd.diveAngles) {
    const angle = fd.diveAngles[dataIdx];
    lines.push(angle == null ? '—' : angle.toFixed(1) + '°');
    colors.push('#f8fafc');
    labels.push('DIVE ANGLE');
  }

  if (config.showScore && fd.speedScore && fd.perfWindowEndTime !== null && t > fd.perfWindowEndTime) {
    lines.push(fd.speedScore.toFixed(2) + ' km/h');
    colors.push('#4ade80');
    labels.push('SPEED SCORE');
  }

  return { lines, colors, labels };
}

function getSampleInfoLines(units, config) {
  const lines = [], colors = [], labels = [];
  if (config.showTime) { lines.push('0:42'); colors.push('#f8fafc'); labels.push('TIME'); }
  if (config.showAltitude) {
    if (units === 'metric') lines.push('3,200 m');
    else if (units === 'imperial') lines.push('10,498 ft');
    else lines.push('3,200 m / 10,498 ft');
    colors.push('#f8fafc');
    labels.push('ALTITUDE');
  }
  if (config.showSpeed) {
    if (units === 'metric') lines.push('412 km/h');
    else if (units === 'imperial') lines.push('256 mph');
    else lines.push('412 km/h / 256 mph');
    colors.push('#f8fafc');
    labels.push('VERT. SPEED');
  }
  if (config.showHSpeed) {
    if (units === 'metric') lines.push('85 km/h');
    else if (units === 'imperial') lines.push('53 mph');
    else lines.push('85 km/h / 53 mph');
    colors.push('#f8fafc');
    labels.push('HORIZ. SPEED');
  }
  if (config.showDiveAngle) { lines.push('67.5°'); colors.push('#f8fafc'); labels.push('DIVE ANGLE'); }
  if (config.showScore) { lines.push('487.32 km/h'); colors.push('#4ade80'); labels.push('SPEED SCORE'); }
  return { lines, colors, labels };
}

function computeInfoBoxSize(ctx, contentRect, lines, scale, labels) {
  const fontSize = Math.round(contentRect.height * 0.035 * (scale || 1));
  const labelFontSize = Math.round(fontSize * 0.55);
  ctx.font = 'bold ' + fontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'top';

  const hasLabels = labels && labels.length;
  const labelHeight = hasLabels ? labelFontSize * 1.2 : 0;
  const itemHeight = fontSize * 1.2 + labelHeight;
  const itemGap = hasLabels ? fontSize * 0.35 : 0;
  const padding = fontSize * 0.6;
  const maxWidth = Math.max(...lines.map(l => ctx.measureText(l).width));
  const boxW = maxWidth + padding * 2;
  const boxH = lines.length * itemHeight + (lines.length - 1) * itemGap + padding * 2;

  return { boxW, boxH, fontSize, labelFontSize, labelHeight, itemHeight, itemGap, padding };
}

function renderInfoWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const config = widget.config;
  const widgetUnits = config.units || units || 'both';
  let lines, colors, labels;
  if (dataIdx >= 0 && state.currentFlightData && dataIdx < state.currentFlightData.times.length) {
    ({ lines, colors, labels } = getInfoLines(dataIdx, widgetUnits, config));
  } else {
    ({ lines, colors, labels } = getSampleInfoLines(widgetUnits, config));
  }
  if (!lines.length) return;

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  const effectiveScale = widget.widgetScale || 1;
  const p = computeInfoBoxSize(ctx, contentRect, lines, effectiveScale, labels);
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;
  const x = cx - p.boxW / 2;
  const y = cy - p.boxH / 2;

  widget._bounds = { x: x, y: y, w: p.boxW, h: p.boxH };

  if (config.showBackground !== false) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, p.boxW, p.boxH, p.fontSize * 0.3);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, p.boxW, p.boxH);
    }
  }

  lines.forEach((line, i) => {
    const itemY = y + p.padding + i * (p.itemHeight + p.itemGap);
    if (labels && labels[i]) {
      ctx.font = '600 ' + p.labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(labels[i], x + p.padding, itemY);
    }
    ctx.font = 'bold ' + p.fontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = (colors && colors[i]) || '#f8fafc';
    ctx.fillText(line, x + p.padding, itemY + p.labelHeight);
  });

  ctx.restore();
}

function renderInfoPreviewCard(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const sampleLines = ['0:42', '3,200 m', '412 km/h'];
  const sampleColors = ['#f8fafc', '#f8fafc', '#f8fafc'];
  const sampleLabels = ['TIME', 'ALTITUDE', 'VERT. SPEED'];
  const contentRect = { width: canvas.width, height: canvas.height };
  const p = computeInfoBoxSize(ctx, contentRect, sampleLines, 3, sampleLabels);
  const x = (canvas.width - p.boxW) / 2;
  const y = (canvas.height - p.boxH) / 2;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, p.boxW, p.boxH, p.fontSize * 0.3);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, p.boxW, p.boxH);
  }
  sampleLines.forEach((line, i) => {
    const itemY = y + p.padding + i * (p.itemHeight + p.itemGap);
    if (sampleLabels[i]) {
      ctx.font = '600 ' + p.labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(sampleLabels[i], x + p.padding, itemY);
    }
    ctx.font = 'bold ' + p.fontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = sampleColors[i] || '#f8fafc';
    ctx.fillText(line, x + p.padding, itemY + p.labelHeight);
  });
}

function buildInfoConfigPanel(widget, drawOverlayPreview, buildUnitsConfig) {
  const wrap = document.createElement('div');

  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  [
    { key: 'showTime', label: t('cfg.infoTime') },
    { key: 'showAltitude', label: t('cfg.infoAltitude') },
    { key: 'showSpeed', label: t('cfg.infoVertSpeed') },
    { key: 'showHSpeed', label: t('cfg.infoHorzSpeed') },
    { key: 'showDiveAngle', label: t('cfg.infoDiveAngle') },
    { key: 'showScore', label: t('cfg.infoScore') },
    { key: 'showBackground', label: t('cfg.showBackground') },
    { key: 'fadeIn', label: t('cfg.fadeIn') },
  ].forEach(({ key, label }) => {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = widget.config[key];
    cb.addEventListener('change', () => {
      widget.config[key] = cb.checked;
      drawOverlayPreview();
      state.scheduleSaveWidgetLayout();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + label));
    checks.appendChild(lbl);
  });
  wrap.appendChild(checks);

  wrap.appendChild(buildUnitsConfig(widget));

  return wrap;
}
