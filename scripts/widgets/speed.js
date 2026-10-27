
function renderSpeedWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const config = widget.config;
  const unitSys = config.units || units || 'both';

  let speedMs = 0;
  if (dataIdx >= 0 && state.currentFlightData && dataIdx < state.currentFlightData.times.length) {
    if (config.dataSource === 'horzSpeed') {
      speedMs = state.currentFlightData.horzSpeeds[dataIdx];
    } else {
      speedMs = state.currentFlightData.vertSpeeds[dataIdx];
    }
  } else {
    speedMs = 114.4; // ~412 km/h sample
  }

  let speedDisplay, unitLabel, maxValue;
  if (unitSys === 'imperial') {
    speedDisplay = speedMs * 2.23694;
    unitLabel = 'MPH';
    maxValue = 350;
  } else {
    speedDisplay = speedMs * 3.6;
    unitLabel = 'KPH';
    maxValue = 550;
  }

  const effectiveScale = widget.widgetScale || 1;
  const size = contentRect.height * 0.25 * effectiveScale;
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;

  const radius = size * 0.38;
  const strokeW = size * 0.06;
  const numFontSize = size * 0.22;
  const unitFontSize = size * 0.09;
  const margin = size * 0.04;

  // Geometry is measured from the arc centre outwards so the box hugs the content. The
  // old square box left ~18 % of its height empty below the unit label, against ~4 %
  // above the arc.
  const numOffset = size * 0.17;                     // number centre, below the arc centre
  const unitOffset = numOffset + numFontSize * 0.7;  // unit label centre
  const topExtent = radius + strokeW / 2;
  const botExtent = Math.max(unitOffset + unitFontSize * 0.5, radius * Math.SQRT1_2 + strokeW / 2);
  const boxW = size;
  const boxH = topExtent + botExtent + margin * 2;
  const boxX = cx - boxW / 2;
  const boxY = cy - boxH / 2;
  const arcCy = boxY + margin + topExtent;

  widget._bounds = { x: boxX, y: boxY, w: boxW, h: boxH };

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  const startAngle = (135 * Math.PI) / 180;
  const endAngle = (405 * Math.PI) / 180;
  const sweepAngle = (270 * Math.PI) / 180;
  const valueFraction = Math.min(Math.max(speedDisplay / maxValue, 0), 1);
  const needleAngle = startAngle + valueFraction * sweepAngle;

  // Keeps the gauge legible over bright footage (snow, clouds, sunlit ground).
  if (config.showShadow !== false) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = size * 0.035;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = size * 0.012;
  }

  if (config.showBackground) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, size * 0.06);
      ctx.fill();
    } else {
      ctx.fillRect(boxX, boxY, boxW, boxH);
    }
  }

  ctx.beginPath();
  ctx.arc(cx, arcCy, radius, startAngle, endAngle);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
  ctx.lineWidth = strokeW;
  ctx.lineCap = 'round';
  ctx.stroke();

  if (valueFraction > 0) {
    ctx.beginPath();
    ctx.arc(cx, arcCy, radius, startAngle, needleAngle);
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = strokeW;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  if (valueFraction > 0) {
    const dotX = cx + radius * Math.cos(needleAngle);
    const dotY = arcCy + radius * Math.sin(needleAngle);
    ctx.beginPath();
    ctx.arc(dotX, dotY, strokeW * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
  }

  ctx.font = 'bold ' + numFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(Math.round(speedDisplay).toString(), cx, arcCy + numOffset);

  ctx.font = '600 ' + unitFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(unitLabel, cx, arcCy + unitOffset);

  if (config.showLabel) {
    const labelText = config.dataSource === 'horzSpeed' ? 'HORIZ' : 'VERT';
    const labelFontSize = size * 0.07;
    ctx.font = '600 ' + labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, cx, arcCy + numOffset - numFontSize * 0.65);
  }

  ctx.restore();
}

function drawSpeedPreviewCard(ctx, canvas, speedText, fraction) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const size = canvas.height * 0.85;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = size * 0.38;
  const strokeW = size * 0.06;
  const startAngle = (135 * Math.PI) / 180;
  const endAngle = (405 * Math.PI) / 180;
  const needleAngle = startAngle + fraction * (270 * Math.PI / 180);

  ctx.beginPath();
  ctx.arc(cx, cy - size * 0.05, radius, startAngle, endAngle);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
  ctx.lineWidth = strokeW;
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy - size * 0.05, radius, startAngle, needleAngle);
  ctx.strokeStyle = '#f8fafc';
  ctx.lineWidth = strokeW;
  ctx.lineCap = 'round';
  ctx.stroke();

  const numFontSize = size * 0.22;
  ctx.font = 'bold ' + numFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(speedText, cx, cy + size * 0.12);

  const unitFontSize = size * 0.09;
  ctx.font = '600 ' + unitFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('KPH', cx, cy + size * 0.12 + numFontSize * 0.7);
}

function renderVertSpeedPreviewCard(ctx, canvas) {
  drawSpeedPreviewCard(ctx, canvas, '412', 0.75);
}

function renderHorzSpeedPreviewCard(ctx, canvas) {
  drawSpeedPreviewCard(ctx, canvas, '85', 0.15);
}

function buildSpeedConfigPanel(widget, drawOverlayPreview, buildUnitsConfig) {
  const wrap = document.createElement('div');

  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  [
    { key: 'showLabel', label: t('cfg.showLabel') },
    { key: 'showBackground', label: t('cfg.showBackground') },
    { key: 'showShadow', label: t('cfg.showShadow'), defaultOn: true },
    { key: 'fadeIn', label: t('cfg.fadeIn') },
  ].forEach(({ key, label, defaultOn }) => {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    // defaultOn keys read `!== false` so widgets from a layout saved before the setting
    // existed still get the shadow.
    cb.checked = defaultOn ? widget.config[key] !== false : !!widget.config[key];
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

  wrap.appendChild(buildUnitsConfig(widget, [
    { value: 'metric', label: t('cfg.metric') },
    { value: 'imperial', label: t('cfg.imperial') },
  ]));

  return wrap;
}
