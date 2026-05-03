
function renderMiniMapWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const fd = state.currentFlightData;
  const config = widget.config;
  const effectiveScale = widget.widgetScale || 1;
  const size = contentRect.height * 0.25 * effectiveScale;
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;
  const x = cx - size / 2;
  const y = cy - size / 2;

  widget._bounds = { x, y, w: size, h: size };

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  if (config.showBackground) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, size, size, size * 0.06);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, size, size);
    }
  }

  if (!fd || !fd.lats || fd.lats.length < 2) {
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + size * 0.3, y + size * 0.2);
    ctx.quadraticCurveTo(x + size * 0.7, y + size * 0.3, x + size * 0.6, y + size * 0.6);
    ctx.quadraticCurveTo(x + size * 0.4, y + size * 0.8, x + size * 0.5, y + size * 0.9);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const lats = fd.lats, lons = fd.lons, alts = fd.altitudes;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = 0; i < lats.length; i++) {
    if (isNaN(lats[i]) || isNaN(lons[i])) continue;
    if (lats[i] < minLat) minLat = lats[i];
    if (lats[i] > maxLat) maxLat = lats[i];
    if (lons[i] < minLon) minLon = lons[i];
    if (lons[i] > maxLon) maxLon = lons[i];
  }

  const latRange = maxLat - minLat || 0.001;
  const cosLat = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const lonRangeAdj = (maxLon - minLon) * cosLat || 0.001;
  const pad = size * 0.1;
  const drawSize = size - pad * 2;

  let scaleX, scaleY, offX = 0, offY = 0;
  if (lonRangeAdj / latRange > 1) {
    scaleX = drawSize / lonRangeAdj;
    scaleY = scaleX;
    offY = (drawSize - latRange * scaleY) / 2;
  } else {
    scaleY = drawSize / latRange;
    scaleX = scaleY;
    offX = (drawSize - lonRangeAdj * scaleX) / 2;
  }

  function px(lat, lon) {
    return {
      x: x + pad + offX + (lon - minLon) * cosLat * scaleX,
      y: y + pad + offY + (maxLat - lat) * scaleY
    };
  }

  const minAlt = Math.min(...alts), maxAlt = Math.max(...alts);
  const altRange = maxAlt - minAlt || 1;

  for (let i = 1; i < lats.length; i++) {
    if (isNaN(lats[i]) || isNaN(lons[i]) || isNaN(lats[i - 1]) || isNaN(lons[i - 1])) continue;
    const p0 = px(lats[i - 1], lons[i - 1]);
    const p1 = px(lats[i], lons[i]);
    const altFrac = (alts[i] - minAlt) / altRange;
    const r = Math.round(56 + (244 - 56) * (1 - altFrac));
    const g = Math.round(189 + (114 - 189) * (1 - altFrac));
    const b = Math.round(248 + (182 - 248) * (1 - altFrac));
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.lineWidth = 1.5 * effectiveScale;
    ctx.stroke();
  }

  if (config.showExitMarker && fd.exitIdx >= 0 && fd.exitIdx < lats.length) {
    const ep = px(lats[fd.exitIdx], lons[fd.exitIdx]);
    ctx.beginPath();
    ctx.arc(ep.x, ep.y, 3 * effectiveScale, 0, Math.PI * 2);
    ctx.fillStyle = '#facc15';
    ctx.fill();
  }

  if (dataIdx >= 0 && dataIdx < lats.length && !isNaN(lats[dataIdx]) && !isNaN(lons[dataIdx])) {
    const cp = px(lats[dataIdx], lons[dataIdx]);
    ctx.beginPath();
    ctx.arc(cp.x, cp.y, 3.5 * effectiveScale, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
  }

  if (config.showLabel) {
    const labelFontSize = size * 0.08;
    ctx.font = '600 ' + labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('MAP', x + pad, y + size - pad);
  }

  ctx.restore();
}

function renderMiniMapPreviewCard(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const r = canvas.height * 0.3;

  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    const t0 = ((i - 1) / steps) * Math.PI * 3;
    const t1 = (i / steps) * Math.PI * 3;
    const r0 = r * 0.2 + (r * 0.8) * ((i - 1) / steps);
    const r1 = r * 0.2 + (r * 0.8) * (i / steps);
    const frac = i / steps;
    const rc = Math.round(56 + (244 - 56) * frac);
    const gc = Math.round(189 + (114 - 189) * frac);
    const bc = Math.round(248 + (182 - 248) * frac);
    ctx.beginPath();
    ctx.moveTo(cx + r0 * Math.cos(t0), cy + r0 * Math.sin(t0));
    ctx.lineTo(cx + r1 * Math.cos(t1), cy + r1 * Math.sin(t1));
    ctx.strokeStyle = `rgb(${rc},${gc},${bc})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(cx + r * 0.2 * Math.cos(0), cy + r * 0.2 * Math.sin(0), 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#facc15';
  ctx.fill();

  const lastT = Math.PI * 3;
  ctx.beginPath();
  ctx.arc(cx + r * Math.cos(lastT), cy + r * Math.sin(lastT), 3, 0, Math.PI * 2);
  ctx.fillStyle = '#f8fafc';
  ctx.fill();
}

function buildMiniMapConfigPanel(widget, drawOverlayPreview) {
  const wrap = document.createElement('div');
  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  [
    { key: 'showLabel', label: 'Show label' },
    { key: 'showBackground', label: 'Show background' },
    { key: 'showExitMarker', label: 'Show exit marker' },
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
