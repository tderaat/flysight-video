// ── Image widget ──
// User-uploaded image (PNG, JPG, WebP, GIF, SVG) that can be placed and scaled
// on the video overlay. The image bytes are stored as a Blob in widget.config
// and round-trip through IndexedDB via structured clone.

const IMAGE_WIDGET_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const IMAGE_WIDGET_ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
const IMAGE_WIDGET_ACCEPTED_EXT = /\.(png|jpe?g|webp|gif|svg)$/i;

function _isAcceptedImageFile(file) {
  if (!file) return false;
  const mime = (file.type || '').toLowerCase();
  if (IMAGE_WIDGET_ACCEPTED_MIME.includes(mime)) return true;
  return IMAGE_WIDGET_ACCEPTED_EXT.test(file.name || '');
}

function _ensureImageLoaded(widget) {
  const blob = widget.config && widget.config.imageBlob;
  if (!blob) {
    if (widget._imageObjectURL) {
      try { URL.revokeObjectURL(widget._imageObjectURL); } catch {}
      widget._imageObjectURL = null;
    }
    widget._image = null;
    widget._imageBlobRef = null;
    return;
  }
  if (widget._image && widget._imageBlobRef === blob) return;

  if (widget._imageObjectURL) {
    try { URL.revokeObjectURL(widget._imageObjectURL); } catch {}
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  widget._image = img;
  widget._imageObjectURL = url;
  widget._imageBlobRef = blob;
  img.onload = () => { drawOverlayPreview(); };
  img.onerror = () => {
    widget._image = null;
    widget._imageBlobRef = null;
    if (widget._imageObjectURL) {
      try { URL.revokeObjectURL(widget._imageObjectURL); } catch {}
      widget._imageObjectURL = null;
    }
    drawOverlayPreview();
  };
  img.src = url;
}

function _imageWidgetSize(widget, contentRect) {
  const effectiveScale = widget.widgetScale || 1;
  const baseHeight = contentRect.height * 0.25 * effectiveScale;
  let aspect = 4 / 3;
  const img = widget._image;
  if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
    aspect = img.naturalWidth / img.naturalHeight;
  }
  const h = baseHeight;
  const w = baseHeight * aspect;
  return { w, h };
}

function _drawImagePlaceholder(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(8, Math.min(w, h) * 0.06));
    ctx.fill();
  } else {
    ctx.fillRect(x, y, w, h);
  }
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.setLineDash([]);

  // Mountain + sun glyph in the center
  const cx = x + w / 2;
  const cy = y + h / 2;
  const glyph = Math.min(w, h) * 0.35;
  ctx.fillStyle = '#94a3b8';
  ctx.beginPath();
  ctx.arc(cx + glyph * 0.35, cy - glyph * 0.25, glyph * 0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - glyph * 0.55, cy + glyph * 0.4);
  ctx.lineTo(cx - glyph * 0.05, cy - glyph * 0.15);
  ctx.lineTo(cx + glyph * 0.25, cy + glyph * 0.15);
  ctx.lineTo(cx + glyph * 0.55, cy - glyph * 0.05);
  ctx.lineTo(cx + glyph * 0.55, cy + glyph * 0.4);
  ctx.closePath();
  ctx.fill();

  if (h > 48) {
    ctx.fillStyle = '#cbd5e1';
    ctx.font = `${Math.max(10, Math.min(13, h * 0.11))}px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('Click to upload image', cx, y + h - Math.max(18, h * 0.18));
  }
  ctx.restore();
}

function renderImageWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  _ensureImageLoaded(widget);

  const { w, h } = _imageWidgetSize(widget, contentRect);
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;
  const x = cx - w / 2;
  const y = cy - h / 2;
  widget._bounds = { x, y, w, h };

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  const img = widget._image;
  const ready = img && img.complete && img.naturalWidth > 0;
  if (ready) {
    ctx.drawImage(img, x, y, w, h);
  } else {
    _drawImagePlaceholder(ctx, x, y, w, h);
  }

  ctx.restore();
}

function renderImagePreviewCard(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const pad = 10;
  const x = pad;
  const y = pad;
  const w = canvas.width - pad * 2;
  const h = canvas.height - pad * 2;

  ctx.save();
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);

  const cx = x + w / 2;
  const cy = y + h / 2;
  const glyph = Math.min(w, h) * 0.55;

  ctx.fillStyle = '#facc15';
  ctx.beginPath();
  ctx.arc(cx + glyph * 0.3, cy - glyph * 0.2, glyph * 0.13, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#94a3b8';
  ctx.beginPath();
  ctx.moveTo(cx - glyph * 0.5, cy + glyph * 0.35);
  ctx.lineTo(cx - glyph * 0.05, cy - glyph * 0.1);
  ctx.lineTo(cx + glyph * 0.2, cy + glyph * 0.15);
  ctx.lineTo(cx + glyph * 0.5, cy - glyph * 0.05);
  ctx.lineTo(cx + glyph * 0.5, cy + glyph * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function _formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function buildImageConfigPanel(widget, drawOverlayPreview) {
  const wrap = document.createElement('div');

  // ── File picker group ──
  const group = document.createElement('div');
  group.className = 'widget-config-group';
  const groupLabel = document.createElement('div');
  groupLabel.className = 'widget-config-group-label';
  groupLabel.textContent = t('cfg.imageFile');
  group.appendChild(groupLabel);

  const status = document.createElement('div');
  status.style.cssText = 'font-size: 0.8rem; color: #cbd5e1; margin-bottom: 6px; word-break: break-all;';
  function refreshStatus() {
    const blob = widget.config && widget.config.imageBlob;
    if (blob) {
      const name = widget.config.imageName || 'image';
      status.textContent = name + ' · ' + _formatFileSize(blob.size);
    } else {
      status.textContent = t('cfg.noImage');
    }
  }
  refreshStatus();
  group.appendChild(status);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';

  const labelBtn = document.createElement('label');
  labelBtn.className = 'trim-btn secondary';
  labelBtn.style.cssText = 'cursor: pointer; display: inline-block;';
  labelBtn.textContent = (widget.config && widget.config.imageBlob) ? t('cfg.replaceImage') : t('cfg.chooseImage');

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = IMAGE_WIDGET_ACCEPTED_MIME.join(',');
  fileInput.style.cssText = 'position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0;';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (!_isAcceptedImageFile(file)) {
      alert(t('cfg.imageType'));
      return;
    }
    if (file.size > IMAGE_WIDGET_MAX_BYTES) {
      alert(t('cfg.imageTooLarge'));
      return;
    }
    if (widget._imageObjectURL) {
      try { URL.revokeObjectURL(widget._imageObjectURL); } catch {}
      widget._imageObjectURL = null;
    }
    widget._image = null;
    widget._imageBlobRef = null;
    widget.config.imageBlob = file;
    widget.config.imageName = file.name;
    widget.config.imageType = file.type || '';
    labelBtn.textContent = t('cfg.replaceImage');
    refreshStatus();
    drawOverlayPreview();
    state.scheduleSaveWidgetLayout();
  });
  labelBtn.appendChild(fileInput);
  btnRow.appendChild(labelBtn);

  const clearBtn = document.createElement('button');
  clearBtn.className = 'trim-btn secondary';
  clearBtn.type = 'button';
  clearBtn.textContent = t('cfg.clear');
  clearBtn.addEventListener('click', () => {
    if (!widget.config.imageBlob) return;
    if (widget._imageObjectURL) {
      try { URL.revokeObjectURL(widget._imageObjectURL); } catch {}
      widget._imageObjectURL = null;
    }
    widget._image = null;
    widget._imageBlobRef = null;
    delete widget.config.imageBlob;
    delete widget.config.imageName;
    delete widget.config.imageType;
    labelBtn.textContent = t('cfg.chooseImage');
    refreshStatus();
    drawOverlayPreview();
    state.scheduleSaveWidgetLayout();
  });
  btnRow.appendChild(clearBtn);

  group.appendChild(btnRow);
  wrap.appendChild(group);

  // ── Fade-in checkbox ──
  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  checks.style.marginTop = '10px';
  const lbl = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!widget.config.fadeIn;
  cb.addEventListener('change', () => {
    widget.config.fadeIn = cb.checked;
    drawOverlayPreview();
    state.scheduleSaveWidgetLayout();
  });
  lbl.appendChild(cb);
  lbl.appendChild(document.createTextNode(' ' + t('cfg.fadeIn')));
  checks.appendChild(lbl);
  wrap.appendChild(checks);

  return wrap;
}
