// ── Translation data ──
// Pure data for the i18n layer (engine lives in scripts/i18n.js).
//
// To add a language later:
//   1. add its code to LANGUAGES in scripts/i18n.js
//   2. add one entry to LANG_META in scripts/i18n.js ({ value, name, code })
//   3. add one block below with the SAME keys as `en`
// English (`en`) is the source of truth and the fallback for any missing key.
//
// Keys are dotted + namespaced by area (nav.*, sidebar.*, video.*, compare.*,
// chart.*, map.*, cfg.*, alert.*). Some values contain {tokens} replaced by
// t(key, params) at call time.
//
// NOTE: the on-canvas video-overlay widget labels (TIME, ALTITUDE, G-FORCE…)
// that get baked into the exported video are intentionally NOT translated —
// exports look identical regardless of UI language. Those live in the widget
// render() functions and are deliberately absent here.

var I18N = {
  en: {
    // Top chrome
    'theme.label': 'Theme',
    'theme.aria': 'Select color theme',
    'theme.darkBlue': 'Dark · Blue',
    'theme.light': 'Light · Gray',
    'theme.darkRed': 'Dark · Red',
    'theme.darkGreen': 'Dark · Green',
    'lang.label': 'Language',
    'lang.aria': 'Select language',

    // Sidebar / upload
    'sidebar.dropTitle': 'Drop a FlySight CSV here, or click to browse',
    'sidebar.dropSubtitle': 'Files are stored locally in your browser',

    // Trim / chart controls
    'btn.compareJumps': 'Compare jumps',
    'btn.createVideoOverlay': 'Create video overlay',
    'btn.jumpOnly': 'Jump only',
    'btn.fullFlight': 'Full flight',
    'tip.zoomIn': 'Zoom in',
    'tip.zoomOut': 'Zoom out',
    'tip.resizeChart': 'Drag to resize chart height',
    'tip.resizeMap': 'Drag to resize map height',
    'tip.resizeMapWidth': 'Drag to resize map/stats width',

    // Page-wide drop overlays
    'drop.csvTitle': 'Drop FlySight CSV anywhere',
    'drop.csvSubtitle': 'Release to load the jump',
    'drop.videoTitle': 'Drop video file anywhere',
    'drop.videoSubtitle': 'Release to load the video',

    // Jump-chip buttons
    'tip.rename': 'Rename',
    'tip.downloadCsv': 'Download CSV',
    'tip.remove': 'Remove',

    // Stats panel
    'stat.speedScore3s': 'Speed Score (3s)',
    'stat.maxVertSpeed': 'Max Vertical Speed',
    'stat.exitAltitude': 'Exit Altitude',
    'stat.speedWindow': 'Speed Window',
    'stat.start': 'Start',
    'stat.end': 'End',
    'stat.utcStart': 'UTC Start',
    'stat.amsterdamTip': 'Amsterdam time: {time}',
    'chart.notEnoughData': 'Not enough data points.',

    // Exit-altitude validation badge
    'exit.valid': 'Valid — max {max}m / 14,000 ft AGL',
    'exit.tooHigh': 'Too high — max {max}m / 14,000 ft AGL',
    'exit.tooLow': 'Too low — min {min}m / 13,000 ft AGL',

    // Chart dataset legend labels (units kept in the label)
    'chart.altitude': 'Altitude (m)',
    'chart.vertSpeed': 'Vertical Speed (km/h)',
    'chart.groundSpeed': 'Ground Speed (km/h)',
    'chart.diveAngle': 'Dive Angle (°)',
    'chart.accelDown': 'Accel Down (m/s²)',
    'chart.satellites': 'Satellites',

    // Chart axis titles
    'axis.time': 'Time (seconds)',
    'axis.altitude': 'Altitude (m)',
    'axis.speed': 'Speed (km/h)',
    'axis.diveAngle': 'Dive Angle (°)',
    'axis.accelDown': 'Accel Down (m/s²)',
    'axis.satellites': 'Satellites',

    // Chart hover tooltip term (before the value)
    'tt.altitude': 'Altitude',
    'tt.vertSpeed': 'Vert Speed',
    'tt.groundSpeed': 'Ground Speed',
    'tt.diveAngle': 'Dive Angle',
    'tt.accelDown': 'Accel Down',
    'tt.satellites': 'Satellites',
    'tt.gForce': 'G-Force',

    // On-chart annotation labels
    'annot.exit': 'EXIT',
    'annot.windowEnd': 'WINDOW END',
    'annot.best3s': 'BEST 3s',

    // Map markers + hover labels
    'map.start': 'Start',
    'map.exit': 'Exit',
    'map.canopy': 'Canopy',
    'map.landing': 'Landing',
    'map.alt': 'Alt',
    'map.vert': 'Vert',
    'map.horz': 'Horz',

    // Chart right-click context menu
    'ctx.setExit': 'Set exit point here',
    'ctx.resetExit': 'Reset to auto-detected exit',

    // Video overlay modal
    'video.title': 'Video Overlay',
    'video.dropTitle': 'Drop a video file here, or click to browse',
    'video.dropSubtitle': 'MP4, WebM, or MOV supported',
    'video.play': 'Play',
    'video.pause': 'Pause',
    'video.markExit': 'Mark exit moment',
    'video.useThisMoment': 'Use this moment',
    'video.notSet': 'Not set',
    'video.reliableMode': 'Reliable mode (slow machines)',
    'video.fullDescent': 'Include full descent (to landing)',
    'video.exportBtn': 'Export video with overlay',
    'video.cancel': 'Cancel',
    'video.widgets': 'Widgets',
    'video.selectedWidget': 'Selected widget',

    // Widget names (picker cards)
    'widget.info': 'Info',
    'widget.vertSpeed': 'Vert. Speed',
    'widget.horzSpeed': 'Horiz. Speed',
    'widget.altGraph': 'Alt. Graph',
    'widget.altimeter': 'Altimeter',
    'widget.speedGraph': 'Speed Graph',
    'widget.miniMap': 'Mini Map',
    'widget.gForce': 'G-Force',
    'widget.image': 'Image',

    // Video export progress / errors
    'video.preparing': 'Preparing...',
    'video.cancelling': 'Cancelling...',
    'video.exportingPct': 'Exporting... {pct}%',
    'video.exportingFrame': 'Exporting frame {i} / {total}...',
    'video.reliableUnavailable': 'Reliable mode not available in this browser — using standard export...',
    'video.errMarkExit': 'Please mark the exit moment first.',
    'video.errNoFlightData': 'No flight data loaded.',
    'video.errNoWidgets': 'No widgets placed on the overlay.',
    'video.errDropVideo': 'Please drop a video file (MP4, WebM, or MOV).',
    'video.errLoad': 'Could not load this video file. Try a different format (MP4, WebM).',
    'video.errRecorder': 'Could not start the export recorder: {msg}',
    'video.errRecorderStart': 'Could not start recording: {msg}',
    'video.errSeek': 'Could not seek the video to the start of the clip: {msg}',
    'video.errPlayback': 'Video playback failed during export. Try enabling Reliable mode for slow machines.',
    'video.errRecording': 'Recording failed: {msg}\n\nTry enabling Reliable mode for slow machines.',
    'video.errNoData': 'Export produced no data.',
    'video.errStalled': 'The export stalled on this machine and was finished early — the saved video may be incomplete. Enable Reliable mode for a full, frame-accurate export.',
    'video.errReliable': 'Reliable export failed: {msg}\n\nYou can uncheck Reliable mode to use the standard export instead.',

    // Compare modal
    'compare.title': 'Compare jumps',
    'compare.tabTopView': 'Top view',
    'compare.tab3dView': '3D view',
    'compare.tabVertSpeed': 'Vert. speed',
    'compare.tabDiveAngle': 'Dive angle',
    'compare.hint3d': 'Drag to rotate · right-drag (or shift-drag) to pan · scroll to zoom',
    'compare.autoRotateAria': 'Auto-rotate 3D view',
    'compare.createClip': 'Create clip',
    'compare.recording': 'Recording',
    'compare.clip30': '30-second clip',
    'compare.clipRealtime': 'Full real-time',
    'compare.clipRealtimeDur': 'Full real-time ({dur})',
    'compare.empty': 'Select one or more jumps from the left.',
    'compare.noJumps': 'No jumps loaded.',
    'compare.insufficient': '(insufficient data)',
    'compare.jumpHeader': 'Jump',
    'compare.errNoRecorder': 'Sorry — your browser does not expose MediaRecorder for canvas video capture.',
    'compare.errCapture': 'Could not capture the 3D canvas: {msg}',

    // Rename modal
    'rename.title': 'Rename jump',
    'rename.cancel': 'Cancel',
    'rename.save': 'Save',

    // Generic alerts
    'alert.onlyCsv': 'Only CSV files can be uploaded here.\n\nRejected: {files}\n\nTo add a video, click "Create video overlay".',
    'alert.jumpExists': 'A jump named "{name}" already exists. Choose a different name.',
    'alert.storageFull': 'Storage is full. Remove some jumps to free space before adding new ones.',

    // Widget config panels
    'cfg.units': 'Units',
    'cfg.metric': 'Metric',
    'cfg.imperial': 'Imperial',
    'cfg.both': 'Both',
    'cfg.showLabel': 'Show label',
    'cfg.showBackground': 'Show background',
    'cfg.fadeIn': 'Fade in before exit',
    'cfg.showMeasuringZone': 'Show measuring zone',
    'cfg.showScoringZone': 'Show scoring zone',
    'cfg.showExitMarker': 'Show exit marker',
    'cfg.infoTime': 'Time (T+/-)',
    'cfg.infoAltitude': 'Altitude',
    'cfg.infoVertSpeed': 'Vertical speed',
    'cfg.infoHorzSpeed': 'Horizontal speed',
    'cfg.infoDiveAngle': 'Dive angle',
    'cfg.infoScore': 'Speed score (after window)',
    'cfg.imageFile': 'Image file',
    'cfg.noImage': 'No image selected',
    'cfg.chooseImage': 'Choose image',
    'cfg.replaceImage': 'Replace image',
    'cfg.clear': 'Clear',
    'cfg.imageType': 'Please choose a PNG, JPG, WebP, GIF, or SVG image.',
    'cfg.imageTooLarge': 'Image is too large (max 10 MB). Please choose a smaller file.',
  },

  de: {
    // Top chrome
    'theme.label': 'Design',
    'theme.aria': 'Farbschema auswählen',
    'theme.darkBlue': 'Dunkel · Blau',
    'theme.light': 'Hell · Grau',
    'theme.darkRed': 'Dunkel · Rot',
    'theme.darkGreen': 'Dunkel · Grün',
    'lang.label': 'Sprache',
    'lang.aria': 'Sprache auswählen',

    // Sidebar / upload
    'sidebar.dropTitle': 'FlySight-CSV hier ablegen oder zum Durchsuchen klicken',
    'sidebar.dropSubtitle': 'Dateien werden lokal in Ihrem Browser gespeichert',

    // Trim / chart controls
    'btn.compareJumps': 'Sprünge vergleichen',
    'btn.createVideoOverlay': 'Video-Overlay erstellen',
    'btn.jumpOnly': 'Nur Sprung',
    'btn.fullFlight': 'Gesamter Flug',
    'tip.zoomIn': 'Vergrößern',
    'tip.zoomOut': 'Verkleinern',
    'tip.resizeChart': 'Ziehen, um die Diagrammhöhe anzupassen',
    'tip.resizeMap': 'Ziehen, um die Kartenhöhe anzupassen',
    'tip.resizeMapWidth': 'Ziehen, um die Breite von Karte/Statistik anzupassen',

    // Page-wide drop overlays
    'drop.csvTitle': 'FlySight-CSV irgendwo ablegen',
    'drop.csvSubtitle': 'Loslassen, um den Sprung zu laden',
    'drop.videoTitle': 'Videodatei irgendwo ablegen',
    'drop.videoSubtitle': 'Loslassen, um das Video zu laden',

    // Jump-chip buttons
    'tip.rename': 'Umbenennen',
    'tip.downloadCsv': 'CSV herunterladen',
    'tip.remove': 'Entfernen',

    // Stats panel
    'stat.speedScore3s': 'Speed-Wertung (3s)',
    'stat.maxVertSpeed': 'Max. Vertikalgeschwindigkeit',
    'stat.exitAltitude': 'Absprunghöhe',
    'stat.speedWindow': 'Speed-Fenster',
    'stat.start': 'Anfang',
    'stat.end': 'Ende',
    'stat.utcStart': 'UTC-Start',
    'stat.amsterdamTip': 'Amsterdamer Zeit: {time}',
    'chart.notEnoughData': 'Nicht genügend Datenpunkte.',

    // Exit-altitude validation badge
    'exit.valid': 'Gültig — max. {max}m / 14.000 ft AGL',
    'exit.tooHigh': 'Zu hoch — max. {max}m / 14.000 ft AGL',
    'exit.tooLow': 'Zu niedrig — min. {min}m / 13.000 ft AGL',

    // Chart dataset legend labels
    'chart.altitude': 'Höhe (m)',
    'chart.vertSpeed': 'Vertikalgeschwindigkeit (km/h)',
    'chart.groundSpeed': 'Bodengeschwindigkeit (km/h)',
    'chart.diveAngle': 'Sturzwinkel (°)',
    'chart.accelDown': 'Beschl. abwärts (m/s²)',
    'chart.satellites': 'Satelliten',

    // Chart axis titles
    'axis.time': 'Zeit (Sekunden)',
    'axis.altitude': 'Höhe (m)',
    'axis.speed': 'Geschwindigkeit (km/h)',
    'axis.diveAngle': 'Sturzwinkel (°)',
    'axis.accelDown': 'Beschl. abwärts (m/s²)',
    'axis.satellites': 'Satelliten',

    // Chart hover tooltip term
    'tt.altitude': 'Höhe',
    'tt.vertSpeed': 'Vertikalgeschw.',
    'tt.groundSpeed': 'Bodengeschw.',
    'tt.diveAngle': 'Sturzwinkel',
    'tt.accelDown': 'Beschl. abwärts',
    'tt.satellites': 'Satelliten',
    'tt.gForce': 'G-Kraft',

    // On-chart annotation labels
    'annot.exit': 'ABSPRUNG',
    'annot.windowEnd': 'FENSTERENDE',
    'annot.best3s': 'BESTE 3s',

    // Map markers + hover labels
    'map.start': 'Start',
    'map.exit': 'Absprung',
    'map.canopy': 'Schirm',
    'map.landing': 'Landung',
    'map.alt': 'Höhe',
    'map.vert': 'Vert.',
    'map.horz': 'Horiz.',

    // Chart right-click context menu
    'ctx.setExit': 'Absprungpunkt hier setzen',
    'ctx.resetExit': 'Auf automatisch erkannten Absprung zurücksetzen',

    // Video overlay modal
    'video.title': 'Video-Overlay',
    'video.dropTitle': 'Videodatei hier ablegen oder zum Durchsuchen klicken',
    'video.dropSubtitle': 'MP4, WebM oder MOV unterstützt',
    'video.play': 'Abspielen',
    'video.pause': 'Pause',
    'video.markExit': 'Absprungmoment markieren',
    'video.useThisMoment': 'Diesen Moment verwenden',
    'video.notSet': 'Nicht gesetzt',
    'video.reliableMode': 'Zuverlässiger Modus (langsame Geräte)',
    'video.fullDescent': 'Gesamten Abstieg einbeziehen (bis zur Landung)',
    'video.exportBtn': 'Video mit Overlay exportieren',
    'video.cancel': 'Abbrechen',
    'video.widgets': 'Widgets',
    'video.selectedWidget': 'Ausgewähltes Widget',

    // Widget names
    'widget.info': 'Info',
    'widget.vertSpeed': 'Vert. Geschw.',
    'widget.horzSpeed': 'Horiz. Geschw.',
    'widget.altGraph': 'Höhendiagramm',
    'widget.altimeter': 'Höhenmesser',
    'widget.speedGraph': 'Speed-Diagramm',
    'widget.miniMap': 'Minikarte',
    'widget.gForce': 'G-Kraft',
    'widget.image': 'Bild',

    // Video export progress / errors
    'video.preparing': 'Wird vorbereitet...',
    'video.cancelling': 'Wird abgebrochen...',
    'video.exportingPct': 'Exportiere... {pct}%',
    'video.exportingFrame': 'Exportiere Frame {i} / {total}...',
    'video.reliableUnavailable': 'Zuverlässiger Modus in diesem Browser nicht verfügbar — Standardexport wird verwendet...',
    'video.errMarkExit': 'Bitte markieren Sie zuerst den Absprungmoment.',
    'video.errNoFlightData': 'Keine Flugdaten geladen.',
    'video.errNoWidgets': 'Keine Widgets auf dem Overlay platziert.',
    'video.errDropVideo': 'Bitte legen Sie eine Videodatei ab (MP4, WebM oder MOV).',
    'video.errLoad': 'Diese Videodatei konnte nicht geladen werden. Versuchen Sie ein anderes Format (MP4, WebM).',
    'video.errRecorder': 'Der Export-Recorder konnte nicht gestartet werden: {msg}',
    'video.errRecorderStart': 'Aufnahme konnte nicht gestartet werden: {msg}',
    'video.errSeek': 'Das Video konnte nicht an den Clip-Anfang gespult werden: {msg}',
    'video.errPlayback': 'Die Videowiedergabe ist während des Exports fehlgeschlagen. Aktivieren Sie den zuverlässigen Modus für langsame Geräte.',
    'video.errRecording': 'Aufnahme fehlgeschlagen: {msg}\n\nAktivieren Sie den zuverlässigen Modus für langsame Geräte.',
    'video.errNoData': 'Der Export hat keine Daten erzeugt.',
    'video.errStalled': 'Der Export ist auf diesem Gerät hängengeblieben und wurde vorzeitig beendet — das gespeicherte Video ist möglicherweise unvollständig. Aktivieren Sie den zuverlässigen Modus für einen vollständigen, bildgenauen Export.',
    'video.errReliable': 'Zuverlässiger Export fehlgeschlagen: {msg}\n\nSie können den zuverlässigen Modus deaktivieren, um den Standardexport zu verwenden.',

    // Compare modal
    'compare.title': 'Sprünge vergleichen',
    'compare.tabTopView': 'Draufsicht',
    'compare.tab3dView': '3D-Ansicht',
    'compare.tabVertSpeed': 'Vert. Geschw.',
    'compare.tabDiveAngle': 'Sturzwinkel',
    'compare.hint3d': 'Ziehen zum Drehen · Rechts-Ziehen (oder Umschalt+Ziehen) zum Verschieben · Scrollen zum Zoomen',
    'compare.autoRotateAria': '3D-Ansicht automatisch drehen',
    'compare.createClip': 'Clip erstellen',
    'compare.recording': 'Aufnahme',
    'compare.clip30': '30-Sekunden-Clip',
    'compare.clipRealtime': 'Voll in Echtzeit',
    'compare.clipRealtimeDur': 'Voll in Echtzeit ({dur})',
    'compare.empty': 'Wählen Sie links einen oder mehrere Sprünge aus.',
    'compare.noJumps': 'Keine Sprünge geladen.',
    'compare.insufficient': '(unzureichende Daten)',
    'compare.jumpHeader': 'Sprung',
    'compare.errNoRecorder': 'Leider stellt Ihr Browser keinen MediaRecorder für die Canvas-Videoaufnahme bereit.',
    'compare.errCapture': 'Das 3D-Canvas konnte nicht aufgenommen werden: {msg}',

    // Rename modal
    'rename.title': 'Sprung umbenennen',
    'rename.cancel': 'Abbrechen',
    'rename.save': 'Speichern',

    // Generic alerts
    'alert.onlyCsv': 'Hier können nur CSV-Dateien hochgeladen werden.\n\nAbgelehnt: {files}\n\nUm ein Video hinzuzufügen, klicken Sie auf "Video-Overlay erstellen".',
    'alert.jumpExists': 'Ein Sprung mit dem Namen "{name}" existiert bereits. Wählen Sie einen anderen Namen.',
    'alert.storageFull': 'Der Speicher ist voll. Entfernen Sie einige Sprünge, um Platz zu schaffen, bevor Sie neue hinzufügen.',

    // Widget config panels
    'cfg.units': 'Einheiten',
    'cfg.metric': 'Metrisch',
    'cfg.imperial': 'Imperial',
    'cfg.both': 'Beide',
    'cfg.showLabel': 'Beschriftung anzeigen',
    'cfg.showBackground': 'Hintergrund anzeigen',
    'cfg.fadeIn': 'Vor dem Absprung einblenden',
    'cfg.showMeasuringZone': 'Messzone anzeigen',
    'cfg.showScoringZone': 'Wertungszone anzeigen',
    'cfg.showExitMarker': 'Absprungmarkierung anzeigen',
    'cfg.infoTime': 'Zeit (T+/-)',
    'cfg.infoAltitude': 'Höhe',
    'cfg.infoVertSpeed': 'Vertikalgeschwindigkeit',
    'cfg.infoHorzSpeed': 'Horizontalgeschwindigkeit',
    'cfg.infoDiveAngle': 'Sturzwinkel',
    'cfg.infoScore': 'Speed-Wertung (nach dem Fenster)',
    'cfg.imageFile': 'Bilddatei',
    'cfg.noImage': 'Kein Bild ausgewählt',
    'cfg.chooseImage': 'Bild auswählen',
    'cfg.replaceImage': 'Bild ersetzen',
    'cfg.clear': 'Löschen',
    'cfg.imageType': 'Bitte wählen Sie ein PNG-, JPG-, WebP-, GIF- oder SVG-Bild.',
    'cfg.imageTooLarge': 'Das Bild ist zu groß (max. 10 MB). Bitte wählen Sie eine kleinere Datei.',
  },

  nl: {
    // Top chrome
    'theme.label': 'Thema',
    'theme.aria': 'Kleurthema kiezen',
    'theme.darkBlue': 'Donker · Blauw',
    'theme.light': 'Licht · Grijs',
    'theme.darkRed': 'Donker · Rood',
    'theme.darkGreen': 'Donker · Groen',
    'lang.label': 'Taal',
    'lang.aria': 'Taal kiezen',

    // Sidebar / upload
    'sidebar.dropTitle': 'Sleep hier een FlySight-CSV, of klik om te bladeren',
    'sidebar.dropSubtitle': 'Bestanden worden lokaal in je browser opgeslagen',

    // Trim / chart controls
    'btn.compareJumps': 'Sprongen vergelijken',
    'btn.createVideoOverlay': 'Video-overlay maken',
    'btn.jumpOnly': 'Alleen sprong',
    'btn.fullFlight': 'Volledige vlucht',
    'tip.zoomIn': 'Inzoomen',
    'tip.zoomOut': 'Uitzoomen',
    'tip.resizeChart': 'Sleep om de grafiekhoogte aan te passen',
    'tip.resizeMap': 'Sleep om de kaarthoogte aan te passen',
    'tip.resizeMapWidth': 'Sleep om de breedte van kaart/statistieken aan te passen',

    // Page-wide drop overlays
    'drop.csvTitle': 'Sleep een FlySight-CSV ergens naartoe',
    'drop.csvSubtitle': 'Laat los om de sprong te laden',
    'drop.videoTitle': 'Sleep een videobestand ergens naartoe',
    'drop.videoSubtitle': 'Laat los om de video te laden',

    // Jump-chip buttons
    'tip.rename': 'Hernoemen',
    'tip.downloadCsv': 'CSV downloaden',
    'tip.remove': 'Verwijderen',

    // Stats panel
    'stat.speedScore3s': 'Speedscore (3s)',
    'stat.maxVertSpeed': 'Max. verticale snelheid',
    'stat.exitAltitude': 'Exithoogte',
    'stat.speedWindow': 'Speedvenster',
    'stat.start': 'Begin',
    'stat.end': 'Einde',
    'stat.utcStart': 'UTC-start',
    'stat.amsterdamTip': 'Amsterdamse tijd: {time}',
    'chart.notEnoughData': 'Niet genoeg datapunten.',

    // Exit-altitude validation badge
    'exit.valid': 'Geldig — max. {max}m / 14.000 ft AGL',
    'exit.tooHigh': 'Te hoog — max. {max}m / 14.000 ft AGL',
    'exit.tooLow': 'Te laag — min. {min}m / 13.000 ft AGL',

    // Chart dataset legend labels
    'chart.altitude': 'Hoogte (m)',
    'chart.vertSpeed': 'Verticale snelheid (km/u)',
    'chart.groundSpeed': 'Grondsnelheid (km/u)',
    'chart.diveAngle': 'Duikhoek (°)',
    'chart.accelDown': 'Versn. omlaag (m/s²)',
    'chart.satellites': 'Satellieten',

    // Chart axis titles
    'axis.time': 'Tijd (seconden)',
    'axis.altitude': 'Hoogte (m)',
    'axis.speed': 'Snelheid (km/u)',
    'axis.diveAngle': 'Duikhoek (°)',
    'axis.accelDown': 'Versn. omlaag (m/s²)',
    'axis.satellites': 'Satellieten',

    // Chart hover tooltip term
    'tt.altitude': 'Hoogte',
    'tt.vertSpeed': 'Vert. snelheid',
    'tt.groundSpeed': 'Grondsnelheid',
    'tt.diveAngle': 'Duikhoek',
    'tt.accelDown': 'Versn. omlaag',
    'tt.satellites': 'Satellieten',
    'tt.gForce': 'G-kracht',

    // On-chart annotation labels
    'annot.exit': 'EXIT',
    'annot.windowEnd': 'EINDE VENSTER',
    'annot.best3s': 'BESTE 3s',

    // Map markers + hover labels
    'map.start': 'Start',
    'map.exit': 'Exit',
    'map.canopy': 'Koepel',
    'map.landing': 'Landing',
    'map.alt': 'Hoogte',
    'map.vert': 'Vert.',
    'map.horz': 'Horiz.',

    // Chart right-click context menu
    'ctx.setExit': 'Exitpunt hier instellen',
    'ctx.resetExit': 'Terug naar automatisch gedetecteerde exit',

    // Video overlay modal
    'video.title': 'Video-overlay',
    'video.dropTitle': 'Sleep hier een videobestand, of klik om te bladeren',
    'video.dropSubtitle': 'MP4, WebM of MOV ondersteund',
    'video.play': 'Afspelen',
    'video.pause': 'Pauze',
    'video.markExit': 'Exitmoment markeren',
    'video.useThisMoment': 'Dit moment gebruiken',
    'video.notSet': 'Niet ingesteld',
    'video.reliableMode': 'Betrouwbare modus (langzame machines)',
    'video.fullDescent': 'Volledige afdaling meenemen (tot landing)',
    'video.exportBtn': 'Video met overlay exporteren',
    'video.cancel': 'Annuleren',
    'video.widgets': 'Widgets',
    'video.selectedWidget': 'Geselecteerde widget',

    // Widget names
    'widget.info': 'Info',
    'widget.vertSpeed': 'Vert. snelheid',
    'widget.horzSpeed': 'Horiz. snelheid',
    'widget.altGraph': 'Hoogtegrafiek',
    'widget.altimeter': 'Hoogtemeter',
    'widget.speedGraph': 'Snelheidsgrafiek',
    'widget.miniMap': 'Minikaart',
    'widget.gForce': 'G-kracht',
    'widget.image': 'Afbeelding',

    // Video export progress / errors
    'video.preparing': 'Voorbereiden...',
    'video.cancelling': 'Annuleren...',
    'video.exportingPct': 'Exporteren... {pct}%',
    'video.exportingFrame': 'Frame {i} / {total} exporteren...',
    'video.reliableUnavailable': 'Betrouwbare modus niet beschikbaar in deze browser — standaardexport wordt gebruikt...',
    'video.errMarkExit': 'Markeer eerst het exitmoment.',
    'video.errNoFlightData': 'Geen vluchtgegevens geladen.',
    'video.errNoWidgets': 'Geen widgets op de overlay geplaatst.',
    'video.errDropVideo': 'Sleep een videobestand (MP4, WebM of MOV).',
    'video.errLoad': 'Kan dit videobestand niet laden. Probeer een ander formaat (MP4, WebM).',
    'video.errRecorder': 'Kan de export-recorder niet starten: {msg}',
    'video.errRecorderStart': 'Kan de opname niet starten: {msg}',
    'video.errSeek': 'Kan de video niet naar het begin van de clip spoelen: {msg}',
    'video.errPlayback': 'Het afspelen van de video is mislukt tijdens het exporteren. Schakel de betrouwbare modus in voor langzame machines.',
    'video.errRecording': 'Opname mislukt: {msg}\n\nSchakel de betrouwbare modus in voor langzame machines.',
    'video.errNoData': 'De export heeft geen gegevens opgeleverd.',
    'video.errStalled': 'De export liep vast op deze machine en is vroegtijdig beëindigd — de opgeslagen video is mogelijk onvolledig. Schakel de betrouwbare modus in voor een volledige, beeldnauwkeurige export.',
    'video.errReliable': 'Betrouwbare export mislukt: {msg}\n\nJe kunt de betrouwbare modus uitschakelen om de standaardexport te gebruiken.',

    // Compare modal
    'compare.title': 'Sprongen vergelijken',
    'compare.tabTopView': 'Bovenaanzicht',
    'compare.tab3dView': '3D-weergave',
    'compare.tabVertSpeed': 'Vert. snelheid',
    'compare.tabDiveAngle': 'Duikhoek',
    'compare.hint3d': 'Sleep om te draaien · rechts-slepen (of shift-slepen) om te pannen · scrollen om te zoomen',
    'compare.autoRotateAria': '3D-weergave automatisch draaien',
    'compare.createClip': 'Clip maken',
    'compare.recording': 'Opnemen',
    'compare.clip30': 'Clip van 30 seconden',
    'compare.clipRealtime': 'Volledig realtime',
    'compare.clipRealtimeDur': 'Volledig realtime ({dur})',
    'compare.empty': 'Selecteer links een of meer sprongen.',
    'compare.noJumps': 'Geen sprongen geladen.',
    'compare.insufficient': '(onvoldoende gegevens)',
    'compare.jumpHeader': 'Sprong',
    'compare.errNoRecorder': 'Helaas stelt je browser geen MediaRecorder beschikbaar voor canvas-video-opname.',
    'compare.errCapture': 'Kan het 3D-canvas niet opnemen: {msg}',

    // Rename modal
    'rename.title': 'Sprong hernoemen',
    'rename.cancel': 'Annuleren',
    'rename.save': 'Opslaan',

    // Generic alerts
    'alert.onlyCsv': 'Hier kunnen alleen CSV-bestanden worden geüpload.\n\nGeweigerd: {files}\n\nKlik op "Video-overlay maken" om een video toe te voegen.',
    'alert.jumpExists': 'Er bestaat al een sprong met de naam "{name}". Kies een andere naam.',
    'alert.storageFull': 'De opslag is vol. Verwijder enkele sprongen om ruimte vrij te maken voordat je nieuwe toevoegt.',

    // Widget config panels
    'cfg.units': 'Eenheden',
    'cfg.metric': 'Metrisch',
    'cfg.imperial': 'Imperiaal',
    'cfg.both': 'Beide',
    'cfg.showLabel': 'Label tonen',
    'cfg.showBackground': 'Achtergrond tonen',
    'cfg.fadeIn': 'Infaden voor exit',
    'cfg.showMeasuringZone': 'Meetzone tonen',
    'cfg.showScoringZone': 'Scorezone tonen',
    'cfg.showExitMarker': 'Exitmarkering tonen',
    'cfg.infoTime': 'Tijd (T+/-)',
    'cfg.infoAltitude': 'Hoogte',
    'cfg.infoVertSpeed': 'Verticale snelheid',
    'cfg.infoHorzSpeed': 'Horizontale snelheid',
    'cfg.infoDiveAngle': 'Duikhoek',
    'cfg.infoScore': 'Speedscore (na het venster)',
    'cfg.imageFile': 'Afbeeldingsbestand',
    'cfg.noImage': 'Geen afbeelding geselecteerd',
    'cfg.chooseImage': 'Afbeelding kiezen',
    'cfg.replaceImage': 'Afbeelding vervangen',
    'cfg.clear': 'Wissen',
    'cfg.imageType': 'Kies een PNG-, JPG-, WebP-, GIF- of SVG-afbeelding.',
    'cfg.imageTooLarge': 'De afbeelding is te groot (max. 10 MB). Kies een kleiner bestand.',
  },

  it: {
    // Top chrome
    'theme.label': 'Tema',
    'theme.aria': 'Seleziona il tema di colore',
    'theme.darkBlue': 'Scuro · Blu',
    'theme.light': 'Chiaro · Grigio',
    'theme.darkRed': 'Scuro · Rosso',
    'theme.darkGreen': 'Scuro · Verde',
    'lang.label': 'Lingua',
    'lang.aria': 'Seleziona la lingua',

    // Sidebar / upload
    'sidebar.dropTitle': 'Trascina qui un CSV FlySight, o clicca per sfogliare',
    'sidebar.dropSubtitle': 'I file vengono salvati localmente nel tuo browser',

    // Trim / chart controls
    'btn.compareJumps': 'Confronta lanci',
    'btn.createVideoOverlay': 'Crea overlay video',
    'btn.jumpOnly': 'Solo lancio',
    'btn.fullFlight': 'Volo completo',
    'tip.zoomIn': 'Ingrandisci',
    'tip.zoomOut': 'Riduci',
    'tip.resizeChart': 'Trascina per ridimensionare l altezza del grafico',
    'tip.resizeMap': 'Trascina per ridimensionare l altezza della mappa',
    'tip.resizeMapWidth': 'Trascina per ridimensionare la larghezza di mappa/statistiche',

    // Page-wide drop overlays
    'drop.csvTitle': 'Trascina un CSV FlySight ovunque',
    'drop.csvSubtitle': 'Rilascia per caricare il lancio',
    'drop.videoTitle': 'Trascina un file video ovunque',
    'drop.videoSubtitle': 'Rilascia per caricare il video',

    // Jump-chip buttons
    'tip.rename': 'Rinomina',
    'tip.downloadCsv': 'Scarica CSV',
    'tip.remove': 'Rimuovi',

    // Stats panel
    'stat.speedScore3s': 'Punteggio velocità (3s)',
    'stat.maxVertSpeed': 'Velocità verticale max',
    'stat.exitAltitude': 'Quota di uscita',
    'stat.speedWindow': 'Finestra velocità',
    'stat.start': 'Inizio',
    'stat.end': 'Fine',
    'stat.utcStart': 'Inizio UTC',
    'stat.amsterdamTip': 'Ora di Amsterdam: {time}',
    'chart.notEnoughData': 'Dati insufficienti.',

    // Exit-altitude validation badge
    'exit.valid': 'Valido — max {max}m / 14.000 ft AGL',
    'exit.tooHigh': 'Troppo alto — max {max}m / 14.000 ft AGL',
    'exit.tooLow': 'Troppo basso — min {min}m / 13.000 ft AGL',

    // Chart dataset legend labels
    'chart.altitude': 'Quota (m)',
    'chart.vertSpeed': 'Velocità verticale (km/h)',
    'chart.groundSpeed': 'Velocità al suolo (km/h)',
    'chart.diveAngle': 'Angolo di caduta (°)',
    'chart.accelDown': 'Accel. in basso (m/s²)',
    'chart.satellites': 'Satelliti',

    // Chart axis titles
    'axis.time': 'Tempo (secondi)',
    'axis.altitude': 'Quota (m)',
    'axis.speed': 'Velocità (km/h)',
    'axis.diveAngle': 'Angolo di caduta (°)',
    'axis.accelDown': 'Accel. in basso (m/s²)',
    'axis.satellites': 'Satelliti',

    // Chart hover tooltip term
    'tt.altitude': 'Quota',
    'tt.vertSpeed': 'Vel. verticale',
    'tt.groundSpeed': 'Vel. al suolo',
    'tt.diveAngle': 'Angolo di caduta',
    'tt.accelDown': 'Accel. in basso',
    'tt.satellites': 'Satelliti',
    'tt.gForce': 'Forza G',

    // On-chart annotation labels
    'annot.exit': 'USCITA',
    'annot.windowEnd': 'FINE FINESTRA',
    'annot.best3s': 'MIGLIORI 3s',

    // Map markers + hover labels
    'map.start': 'Inizio',
    'map.exit': 'Uscita',
    'map.canopy': 'Vela',
    'map.landing': 'Atterraggio',
    'map.alt': 'Quota',
    'map.vert': 'Vert.',
    'map.horz': 'Oriz.',

    // Chart right-click context menu
    'ctx.setExit': 'Imposta qui il punto di uscita',
    'ctx.resetExit': 'Ripristina uscita rilevata automaticamente',

    // Video overlay modal
    'video.title': 'Overlay video',
    'video.dropTitle': 'Trascina qui un file video, o clicca per sfogliare',
    'video.dropSubtitle': 'MP4, WebM o MOV supportati',
    'video.play': 'Riproduci',
    'video.pause': 'Pausa',
    'video.markExit': "Segna il momento dell'uscita",
    'video.useThisMoment': 'Usa questo momento',
    'video.notSet': 'Non impostato',
    'video.reliableMode': 'Modalità affidabile (macchine lente)',
    'video.fullDescent': "Includi l'intera discesa (fino all'atterraggio)",
    'video.exportBtn': 'Esporta video con overlay',
    'video.cancel': 'Annulla',
    'video.widgets': 'Widget',
    'video.selectedWidget': 'Widget selezionato',

    // Widget names
    'widget.info': 'Info',
    'widget.vertSpeed': 'Vel. vert.',
    'widget.horzSpeed': 'Vel. oriz.',
    'widget.altGraph': 'Grafico quota',
    'widget.altimeter': 'Altimetro',
    'widget.speedGraph': 'Grafico velocità',
    'widget.miniMap': 'Mini mappa',
    'widget.gForce': 'Forza G',
    'widget.image': 'Immagine',

    // Video export progress / errors
    'video.preparing': 'Preparazione...',
    'video.cancelling': 'Annullamento...',
    'video.exportingPct': 'Esportazione... {pct}%',
    'video.exportingFrame': 'Esportazione fotogramma {i} / {total}...',
    'video.reliableUnavailable': 'Modalità affidabile non disponibile in questo browser — uso esportazione standard...',
    'video.errMarkExit': "Segna prima il momento dell'uscita.",
    'video.errNoFlightData': 'Nessun dato di volo caricato.',
    'video.errNoWidgets': "Nessun widget posizionato sull'overlay.",
    'video.errDropVideo': 'Trascina un file video (MP4, WebM o MOV).',
    'video.errLoad': 'Impossibile caricare questo file video. Prova un altro formato (MP4, WebM).',
    'video.errRecorder': "Impossibile avviare il registratore di esportazione: {msg}",
    'video.errRecorderStart': 'Impossibile avviare la registrazione: {msg}',
    'video.errSeek': "Impossibile posizionare il video all'inizio della clip: {msg}",
    'video.errPlayback': "La riproduzione del video è fallita durante l'esportazione. Attiva la modalità affidabile per le macchine lente.",
    'video.errRecording': 'Registrazione fallita: {msg}\n\nAttiva la modalità affidabile per le macchine lente.',
    'video.errNoData': "L'esportazione non ha prodotto dati.",
    'video.errStalled': "L'esportazione si è bloccata su questa macchina ed è stata terminata in anticipo — il video salvato potrebbe essere incompleto. Attiva la modalità affidabile per un'esportazione completa e fedele ai fotogrammi.",
    'video.errReliable': "Esportazione affidabile fallita: {msg}\n\nPuoi disattivare la modalità affidabile per usare l'esportazione standard.",

    // Compare modal
    'compare.title': 'Confronta lanci',
    'compare.tabTopView': 'Vista dall\'alto',
    'compare.tab3dView': 'Vista 3D',
    'compare.tabVertSpeed': 'Vel. vert.',
    'compare.tabDiveAngle': 'Angolo di caduta',
    'compare.hint3d': 'Trascina per ruotare · trascina con il destro (o shift+trascina) per spostare · scorri per zoomare',
    'compare.autoRotateAria': 'Rotazione automatica vista 3D',
    'compare.createClip': 'Crea clip',
    'compare.recording': 'Registrazione',
    'compare.clip30': 'Clip di 30 secondi',
    'compare.clipRealtime': 'Tempo reale completo',
    'compare.clipRealtimeDur': 'Tempo reale completo ({dur})',
    'compare.empty': 'Seleziona uno o più lanci dalla colonna a sinistra.',
    'compare.noJumps': 'Nessun lancio caricato.',
    'compare.insufficient': '(dati insufficienti)',
    'compare.jumpHeader': 'Lancio',
    'compare.errNoRecorder': 'Spiacenti — il tuo browser non espone MediaRecorder per la cattura video dal canvas.',
    'compare.errCapture': 'Impossibile catturare il canvas 3D: {msg}',

    // Rename modal
    'rename.title': 'Rinomina lancio',
    'rename.cancel': 'Annulla',
    'rename.save': 'Salva',

    // Generic alerts
    'alert.onlyCsv': 'Qui si possono caricare solo file CSV.\n\nRifiutati: {files}\n\nPer aggiungere un video, clicca su "Crea overlay video".',
    'alert.jumpExists': 'Esiste già un lancio chiamato "{name}". Scegli un altro nome.',
    'alert.storageFull': 'Spazio di archiviazione pieno. Rimuovi alcuni lanci per liberare spazio prima di aggiungerne di nuovi.',

    // Widget config panels
    'cfg.units': 'Unità',
    'cfg.metric': 'Metrico',
    'cfg.imperial': 'Imperiale',
    'cfg.both': 'Entrambi',
    'cfg.showLabel': "Mostra etichetta",
    'cfg.showBackground': 'Mostra sfondo',
    'cfg.fadeIn': "Dissolvenza prima dell'uscita",
    'cfg.showMeasuringZone': 'Mostra zona di misurazione',
    'cfg.showScoringZone': 'Mostra zona di punteggio',
    'cfg.showExitMarker': "Mostra marcatore di uscita",
    'cfg.infoTime': 'Tempo (T+/-)',
    'cfg.infoAltitude': 'Quota',
    'cfg.infoVertSpeed': 'Velocità verticale',
    'cfg.infoHorzSpeed': 'Velocità orizzontale',
    'cfg.infoDiveAngle': 'Angolo di caduta',
    'cfg.infoScore': 'Punteggio velocità (dopo la finestra)',
    'cfg.imageFile': 'File immagine',
    'cfg.noImage': 'Nessuna immagine selezionata',
    'cfg.chooseImage': 'Scegli immagine',
    'cfg.replaceImage': 'Sostituisci immagine',
    'cfg.clear': 'Cancella',
    'cfg.imageType': 'Scegli un\'immagine PNG, JPG, WebP, GIF o SVG.',
    'cfg.imageTooLarge': 'Immagine troppo grande (max 10 MB). Scegli un file più piccolo.',
  },
};
