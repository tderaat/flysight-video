
// Score text for the chosen units. The speed score is in km/h; null when the jump has none.
function getScoreText(units) {
  const fd = state.currentFlightData;
  const score = fd && fd.speedScore;
  if (!score) return units === 'imperial' ? '— mph' : '— km/h';
  if (units === 'metric') return score.toFixed(2) + ' km/h';
  if (units === 'imperial') return (score * 0.621371).toFixed(2) + ' mph';
  return score.toFixed(2) + ' km/h / ' + (score * 0.621371).toFixed(2) + ' mph';
}

// Only the speed score, shown once the FAI performance window has ended (same moment the
// Info widget shows it). Before that nothing is drawn, but the bounds are still laid out so
// the widget stays selectable, movable, resizable and deletable. With no exit synced yet
// (dataIdx -1) it shows like the other widgets' samples, with the value blurred.
function renderScoreWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const fd = state.currentFlightData;
  const config = widget.config;
  const widgetUnits = config.units || 'both';
  const showLabel = config.showLabel !== false;

  const lines = [getScoreText(widgetUnits)];
  const labels = showLabel ? ['SCORE'] : null;

  const effectiveScale = widget.widgetScale || 1;
  const p = computeInfoBoxSize(ctx, contentRect, lines, effectiveScale, labels);
  const x = widget.x * contentRect.width - p.boxW / 2;
  const y = widget.y * contentRect.height - p.boxH / 2;

  widget._bounds = { x: x, y: y, w: p.boxW, h: p.boxH };

  const hasData = fd && fd.times && dataIdx >= 0 && dataIdx < fd.times.length;
  const reached = hasData && fd.speedScore && fd.perfWindowEndTime !== null
    && fd.times[dataIdx] > fd.perfWindowEndTime;
  if (hasData && !reached) {
    // Editor only: a dashed outline so the hidden widget can still be found and selected,
    // with a note saying why it is empty. The note is editor UI, never in the export, so
    // unlike the on-video labels it is translated.
    if (contentRect.isPreview) {
      ctx.save();
      ctx.strokeStyle = 'rgba(248, 250, 252, 0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, p.boxW, p.boxH, p.fontSize * 0.3);
      else ctx.rect(x, y, p.boxW, p.boxH);
      ctx.stroke();

      // fillText() ignores '\n', so the note's lines are drawn one by one and
      // the widest of them is what has to fit the box.
      const lines = t('overlay.scoreHidden').split('\n');
      let noteSize = p.labelFontSize;
      ctx.font = '600 ' + noteSize + 'px "Segoe UI", system-ui, sans-serif';
      const fit = p.boxW - p.padding * 2;
      const noteW = Math.max(...lines.map(l => ctx.measureText(l).width));
      if (noteW > fit) {
        noteSize *= fit / noteW;
        ctx.font = '600 ' + noteSize + 'px "Segoe UI", system-ui, sans-serif';
      }
      // A dark shadow, not a box fill (a filled ghost read as a different
      // background), so the note stays legible over bright sky.
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowBlur = noteSize * 0.5;
      ctx.fillStyle = 'rgba(248, 250, 252, 0.85)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lineH = noteSize * 1.25;
      const firstY = y + p.boxH / 2 - (lines.length - 1) * lineH / 2;
      lines.forEach((l, i) => ctx.fillText(l, x + p.boxW / 2, firstY + i * lineH));
      ctx.restore();
    }
    return;
  }

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;
  ctx.textBaseline = 'top';

  // Same drop shadow as the Info widget's default, for legibility over bright footage.
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = p.fontSize * 0.3;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = p.fontSize * 0.1;

  if (config.showBackground !== false) {
    ctx.fillStyle = widgetBackgroundFill(config);
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, p.boxW, p.boxH, p.fontSize * 0.3);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, p.boxW, p.boxH);
    }
  }

  if (showLabel) {
    ctx.font = '600 ' + p.labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(labels[0], x + p.padding, y + p.padding);
  }
  ctx.font = 'bold ' + p.fontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#4ade80';
  ctx.fillText(lines[0], x + p.padding, y + p.padding + p.labelHeight);

  ctx.restore();
}

function renderScorePreviewCard(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const line = '487.32 km/h';
  const label = 'SCORE';
  const p = computeInfoBoxSize(ctx, { width: canvas.width, height: canvas.height }, [line], 4, [label]);
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
  ctx.font = '600 ' + p.labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(label, x + p.padding, y + p.padding);
  ctx.font = 'bold ' + p.fontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#4ade80';
  ctx.fillText(line, x + p.padding, y + p.padding + p.labelHeight);
}

function buildScoreConfigPanel(widget, drawOverlayPreview, buildUnitsConfig) {
  const wrap = document.createElement('div');
  // Both checkboxes default on and read `!== false`, so widgets saved before a key existed keep it on.
  wrap.appendChild(buildConfigSection(t('cfg.display'), [
    buildConfigChecks(widget, [{ key: 'showLabel', label: t('cfg.showLabel'), defaultOn: true }]),
    buildUnitsConfig(widget),
  ]));
  wrap.appendChild(buildBackgroundSection(widget, true));
  return wrap;
}
