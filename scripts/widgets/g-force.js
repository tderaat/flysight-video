
function renderGForceWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const fd = state.currentFlightData;
  const config = widget.config;
  const effectiveScale = widget.widgetScale || 1;

  let gVal = 1.0;
  if (dataIdx >= 1 && fd && fd.times && dataIdx < fd.times.length) {
    let totalG = 0, count = 0;
    for (let k = Math.max(1, dataIdx - 1); k <= Math.min(fd.times.length - 1, dataIdx + 1); k++) {
      const dt = fd.times[k] - fd.times[k - 1];
      if (dt <= 0) continue;
      const dvN = fd.velNs[k] - fd.velNs[k - 1];
      const dvE = fd.velEs[k] - fd.velEs[k - 1];
      const dvD = fd.vertSpeeds[k] - fd.vertSpeeds[k - 1];
      const accel = Math.sqrt(dvN * dvN + dvE * dvE + dvD * dvD) / dt;
      totalG += accel / 9.81;
      count++;
    }
    gVal = count > 0 ? totalG / count : 1.0;
  } else if (!fd || !fd.times) {
    gVal = 2.5;
  }

  const barW = contentRect.height * 0.05 * effectiveScale;
  const barH = contentRect.height * 0.25 * effectiveScale;
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;
  const bx = cx - barW / 2;
  const by = cy - barH / 2;
  const totalW = barW + barW * 2.5;
  widget._bounds = { x: cx - totalW / 2, y: by, w: totalW, h: barH };

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  if (config.showBackground) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    const bgX = cx - totalW / 2 - barW * 0.3;
    const bgW = totalW + barW * 0.6;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(bgX, by - barW * 0.3, bgW, barH + barW * 0.6, barW * 0.3);
      ctx.fill();
    } else {
      ctx.fillRect(bgX, by - barW * 0.3, bgW, barH + barW * 0.6);
    }
  }

  const maxG = 5;

  ctx.fillStyle = 'rgba(148, 163, 184, 0.15)';
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(bx, by, barW, barH, barW * 0.2);
    ctx.fill();
  } else {
    ctx.fillRect(bx, by, barW, barH);
  }

  const fillFrac = Math.min(gVal / maxG, 1);
  const fillH = barH * fillFrac;
  if (fillH > 0) {
    ctx.save();
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(bx, by, barW, barH, barW * 0.2);
      ctx.clip();
    }
    let barColor;
    if (gVal <= 2) barColor = '#4ade80';
    else if (gVal <= 3) barColor = '#facc15';
    else barColor = '#ef4444';
    ctx.fillStyle = barColor;
    ctx.fillRect(bx, by + barH - fillH, barW, fillH);
    ctx.restore();
  }

  const oneGY = by + barH - (barH * (1 / maxG));
  ctx.strokeStyle = 'rgba(248, 250, 252, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bx - 2, oneGY);
  ctx.lineTo(bx + barW + 2, oneGY);
  ctx.stroke();

  const textX = bx + barW + barW * 0.5;
  const numFontSize = barH * 0.18;
  ctx.font = 'bold ' + numFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(gVal.toFixed(1), textX, cy);

  const labelFontSize = barH * 0.1;
  ctx.font = '600 ' + labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('G', textX, cy + numFontSize * 0.8);

  if (config.showLabel) {
    const lFontSize = barH * 0.08;
    ctx.font = '600 ' + lFontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('G-FORCE', cx, by - barW * 0.15);
  }

  ctx.restore();
}

function renderGForcePreviewCard(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const barW = canvas.width * 0.15;
  const barH = canvas.height * 0.7;
  const bx = canvas.width * 0.3;
  const by = (canvas.height - barH) / 2;

  ctx.fillStyle = 'rgba(148, 163, 184, 0.15)';
  ctx.fillRect(bx, by, barW, barH);

  const fillH = barH * 0.5;
  ctx.fillStyle = '#facc15';
  ctx.fillRect(bx, by + barH - fillH, barW, fillH);

  const oneGY = by + barH - (barH * 0.2);
  ctx.strokeStyle = 'rgba(248, 250, 252, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bx - 1, oneGY);
  ctx.lineTo(bx + barW + 1, oneGY);
  ctx.stroke();

  const numFontSize = barH * 0.2;
  ctx.font = 'bold ' + numFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('2.5', bx + barW + 4, canvas.height / 2);

  const labelFontSize = barH * 0.12;
  ctx.font = '600 ' + labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('G', bx + barW + 4, canvas.height / 2 + numFontSize * 0.8);
}

function buildGForceConfigPanel(widget, drawOverlayPreview) {
  const wrap = document.createElement('div');
  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  [
    { key: 'showLabel', label: 'Show label' },
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
