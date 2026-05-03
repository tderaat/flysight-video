// ── Altimaster-style analog altimeter widget ──
// Renders a classic skydiving altimeter dial: circular white face,
// numbers 0–11 (x1000 ft), red danger zone, rotating needle.

function _drawAltimeterDial(ctx, cx, cy, radius, altFt) {
  // Dial face — white circle with dark border
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#f0f0ec';
  ctx.fill();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = radius * 0.06;
  ctx.stroke();

  // Inner ring
  const inner = radius * 0.88;

  // Color-coded danger zones: 0-2k red, 2-3k orange, 3-4k yellow
  var dangerZones = [
    { from: 0, to: 2, fill: 'rgba(220, 38, 38, 0.25)', stroke: 'rgba(220, 38, 38, 0.6)' },
    { from: 2, to: 3, fill: 'rgba(245, 158, 11, 0.25)', stroke: 'rgba(245, 158, 11, 0.6)' },
    { from: 3, to: 4, fill: 'rgba(234, 179, 8, 0.25)',  stroke: 'rgba(234, 179, 8, 0.6)' },
  ];
  dangerZones.forEach(function(zone) {
    var a0 = -Math.PI / 2 + (zone.from / 12) * Math.PI * 2;
    var a1 = -Math.PI / 2 + (zone.to / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, inner, a0, a1);
    ctx.closePath();
    ctx.fillStyle = zone.fill;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, inner, a0, a1);
    ctx.strokeStyle = zone.stroke;
    ctx.lineWidth = radius * 0.02;
    ctx.stroke();
  });

  // Tick marks and numbers (0–11)
  for (let i = 0; i < 12; i++) {
    const angle = -Math.PI / 2 + (i / 12) * Math.PI * 2;

    // Major tick
    const outerTick = radius * 0.85;
    const innerTick = radius * 0.72;
    ctx.beginPath();
    ctx.moveTo(cx + outerTick * Math.cos(angle), cy + outerTick * Math.sin(angle));
    ctx.lineTo(cx + innerTick * Math.cos(angle), cy + innerTick * Math.sin(angle));
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = radius * 0.03;
    ctx.stroke();

    // Minor ticks (5 subdivisions between each number)
    for (let j = 1; j < 5; j++) {
      const minAngle = -Math.PI / 2 + ((i + j / 5) / 12) * Math.PI * 2;
      const minOuter = radius * 0.85;
      const minInner = radius * 0.78;
      ctx.beginPath();
      ctx.moveTo(cx + minOuter * Math.cos(minAngle), cy + minOuter * Math.sin(minAngle));
      ctx.lineTo(cx + minInner * Math.cos(minAngle), cy + minInner * Math.sin(minAngle));
      ctx.strokeStyle = '#555';
      ctx.lineWidth = radius * 0.012;
      ctx.stroke();
    }

    // Number
    const numR = radius * 0.6;
    const numX = cx + numR * Math.cos(angle);
    const numY = cy + numR * Math.sin(angle);
    const fontSize = radius * 0.18;
    ctx.font = 'bold ' + fontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#1a1a1a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(i.toString(), numX, numY);
  }

  // "x 1000" label
  const smallFont = radius * 0.09;
  ctx.font = '600 ' + smallFont + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#555';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('x 1000', cx, cy + radius * 0.22);

  // Needle — points to altitude in thousands of feet
  const thousands = altFt / 1000;
  const needleAngle = -Math.PI / 2 + (thousands / 12) * Math.PI * 2;
  const needleLen = radius * 0.7;
  const tailLen = radius * 0.15;
  const needleW = radius * 0.025;

  // Needle shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = radius * 0.04;
  ctx.shadowOffsetX = radius * 0.01;
  ctx.shadowOffsetY = radius * 0.01;

  ctx.beginPath();
  const tipX = cx + needleLen * Math.cos(needleAngle);
  const tipY = cy + needleLen * Math.sin(needleAngle);
  const tailX = cx - tailLen * Math.cos(needleAngle);
  const tailY = cy - tailLen * Math.sin(needleAngle);
  const perpX = Math.cos(needleAngle + Math.PI / 2);
  const perpY = Math.sin(needleAngle + Math.PI / 2);

  ctx.moveTo(tipX, tipY);
  ctx.lineTo(cx + perpX * needleW, cy + perpY * needleW);
  ctx.lineTo(tailX, tailY);
  ctx.lineTo(cx - perpX * needleW, cy - perpY * needleW);
  ctx.closePath();
  ctx.fillStyle = '#dc2626';
  ctx.fill();
  ctx.restore();

  // Center cap
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.06, 0, Math.PI * 2);
  ctx.fillStyle = '#1a1a1a';
  ctx.fill();
}

function renderAltimeterWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const config = widget.config;
  const fd = state.currentFlightData;

  let altM = 0, groundAlt = 0;
  if (dataIdx >= 0 && fd && fd.altitudes && dataIdx < fd.altitudes.length) {
    altM = fd.altitudes[dataIdx];
    groundAlt = Math.min(...fd.altitudes);
  } else {
    altM = 3200; groundAlt = 0;
  }

  const agl = altM - groundAlt;
  const altFt = agl * 3.28084;

  const effectiveScale = widget.widgetScale || 1;
  const size = contentRect.height * 0.28 * effectiveScale;
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;
  widget._bounds = { x: cx - size / 2, y: cy - size / 2, w: size, h: size };

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  if (config.showBackground) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(cx - size / 2, cy - size / 2, size, size, size * 0.06);
      ctx.fill();
    } else {
      ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
    }
  }

  const radius = size * 0.42;
  _drawAltimeterDial(ctx, cx, cy, radius, altFt);


  ctx.restore();
}

function renderAltimeterPreviewCard(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const radius = Math.min(canvas.width, canvas.height) * 0.38;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  _drawAltimeterDial(ctx, cx, cy, radius, 10500); // ~10,500 ft sample
}

function buildAltimeterConfigPanel(widget, drawOverlayPreview) {
  const wrap = document.createElement('div');
  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  [
    { key: 'showBackground', label: 'Show background' },
    { key: 'fadeIn', label: 'Fade in before exit' },
  ].forEach(({ key, label }) => {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!widget.config[key];
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
  return wrap;
}
