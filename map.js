document.addEventListener('DOMContentLoaded', async () => {
  const mapWorld = document.querySelector('[data-map-world]');
  const markers = document.querySelector('[data-map-markers]');
  const dispatchList = document.querySelector('[data-dispatch-list]');
  const title = document.querySelector('[data-selection-title]');
  const description = document.querySelector('[data-selection-description]');
  const callCount = document.querySelector('[data-call-count]');
  const callCountLabel = document.querySelector('[data-call-count-label]');
  const unitCount = document.querySelector('[data-unit-count]');
  const toast = document.querySelector('.toast');
  const isPreview = new URLSearchParams(window.location.search).get('preview') === '1';
  let toastTimer;
  let zoom = 1;
  let nextCallId = 3;

  const showToast = (message) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3000);
  };

  if (isPreview) {
    const serverName = document.querySelector('[data-map-server]');
    if (serverName) serverName.textContent = 'Cedar Valley · Preview';
  } else {
    try {
      const response = await fetch('/api/map');
      if (response.status === 401) {
        window.location.assign('/');
        return;
      }
      if (!response.ok) {
        window.location.assign('/dashboard.html');
        return;
      }
      const mapInfo = await response.json();
      const serverName = document.querySelector('[data-map-server]');
      if (serverName) serverName.textContent = mapInfo.serverName;
    } catch {
      showToast('Could not load the verified server for this simulation.');
    }
  }

  const units = [
    { id: 'unit-pd-12', label: 'PD-12', type: 'police', x: 168, y: 465, detail: 'Riley · Northgate · Available' },
    { id: 'unit-pd-04', label: 'PD-04', type: 'police', x: 414, y: 405, detail: 'Jordan · Old Town · En route' },
    { id: 'unit-ems-03', label: 'EMS-03', type: 'fire', x: 665, y: 445, detail: 'Casey · Cedar Valley Hospital · Available' }
  ];

  const calls = [
    { id: 'call-1', label: '10-50', kind: 'Traffic collision', location: 'Riverside Bridge · State Route 8', x: 568, y: 652, status: 'Unit assigned' },
    { id: 'call-2', label: '10-11', kind: 'Traffic stop', location: 'Northgate Avenue · Route 3', x: 293, y: 284, status: 'Awaiting unit' }
  ];

  const setSelection = (heading, detail) => {
    if (title) title.textContent = heading;
    if (description) description.textContent = detail;
  };

  const updateCounts = () => {
    if (callCount) callCount.textContent = String(calls.length);
    if (callCountLabel) callCountLabel.textContent = String(calls.length);
    if (unitCount) unitCount.textContent = String(units.length);
  };

  const addMarker = (item, isCall) => {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.classList.add('map-marker', isCall ? 'map-call-marker' : 'map-unit-marker');
    group.setAttribute('transform', `translate(${item.x} ${item.y})`);
    group.setAttribute('tabindex', '0');
    group.setAttribute('role', 'button');
    group.setAttribute('aria-label', isCall
      ? `${item.kind} at ${item.location}`
      : `${item.label}: ${item.detail}`);

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', isCall ? '17' : '15');
    circle.setAttribute('class', isCall ? 'map-marker-circle call-circle' : `map-marker-circle ${item.type}-circle`);
    group.append(circle);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dy', '4');
    text.setAttribute('class', 'map-marker-symbol');
    text.textContent = isCall ? '!' : item.type === 'police' ? 'P' : '+';
    group.append(text);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('y', isCall ? '-25' : '30');
    label.setAttribute('class', 'map-marker-label');
    label.textContent = item.label;
    group.append(label);

    const select = () => setSelection(
      isCall ? item.kind : item.label,
      isCall ? `${item.location} · ${item.status}` : item.detail
    );
    group.addEventListener('click', (event) => {
      event.stopPropagation();
      select();
    });
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });
    markers?.append(group);
    return group;
  };

  units.forEach((unit) => addMarker(unit, false));
  calls.forEach((call) => addMarker(call, true));

  const renderCalls = () => {
    if (!dispatchList) return;
    dispatchList.replaceChildren();
    calls.forEach((call) => {
      const button = document.createElement('button');
      button.className = 'dispatch-call';
      button.type = 'button';
      const top = document.createElement('span');
      top.className = 'dispatch-call-top';
      const kind = document.createElement('strong');
      kind.textContent = call.kind;
      const code = document.createElement('span');
      code.className = 'call-code';
      code.textContent = call.label;
      top.append(kind, code);
      const location = document.createElement('small');
      location.textContent = call.location;
      const status = document.createElement('span');
      status.className = 'dispatch-call-status';
      status.textContent = call.status;
      button.append(top, location, status);
      button.addEventListener('click', () => setSelection(call.kind, `${call.location} · ${call.status}`));
      dispatchList.append(button);
    });
  };

  renderCalls();
  updateCounts();

  document.querySelectorAll('[data-focus-unit]').forEach((button) => {
    button.addEventListener('click', () => {
      const unit = units.find((item) => item.id === button.dataset.focusUnit);
      if (!unit) return;
      setSelection(unit.label, unit.detail);
      markers?.querySelectorAll('.map-unit-marker').forEach((marker) => marker.classList.remove('marker-selected'));
      markers?.querySelector(`[aria-label^="${unit.label}"]`)?.classList.add('marker-selected');
    });
  });

  document.querySelector('[data-create-call]')?.addEventListener('click', () => {
    const locations = [
      { kind: 'Welfare check', label: '10-22', location: 'Cedar Park · West District', x: 280, y: 500 },
      { kind: 'Road hazard', label: '10-46', location: 'Pine Ridge Boulevard', x: 940, y: 300 },
      { kind: 'Medical assist', label: '10-52', location: 'Civic Center · Central', x: 610, y: 390 }
    ];
    const spot = locations[(nextCallId - 3) % locations.length];
    const call = { id: `call-${nextCallId}`, ...spot, status: 'Awaiting unit' };
    nextCallId += 1;
    calls.unshift(call);
    addMarker(call, true);
    renderCalls();
    updateCounts();
    setSelection(call.kind, `${call.location} · Awaiting unit`);
    showToast(`Simulated ${call.kind.toLowerCase()} added to the dispatch board.`);
  });

  document.querySelector('[data-map-zoom-in]')?.addEventListener('click', () => {
    zoom = Math.min(1.7, zoom + 0.15);
    if (mapWorld) mapWorld.style.transform = `scale(${zoom})`;
  });
  document.querySelector('[data-map-zoom-out]')?.addEventListener('click', () => {
    zoom = Math.max(0.8, zoom - 0.15);
    if (mapWorld) mapWorld.style.transform = `scale(${zoom})`;
  });
  document.querySelector('[data-map-reset]')?.addEventListener('click', () => {
    zoom = 1;
    if (mapWorld) mapWorld.style.transform = 'scale(1)';
    setSelection('Select a marker', 'Click a unit or call on the map to see its simulation details.');
  });
});
