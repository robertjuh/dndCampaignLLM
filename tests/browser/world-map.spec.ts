import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { outcomeSchema, templateCharacter, type Snapshot } from '../../shared/schema';
import { initialState } from '../../shared/rules';

import { worldMapPositions } from '../../shared/world-map-layout';

async function mappedTable(page: Page) {
  const response = await page.request.post('/api/campaigns', {
    headers: { 'x-gather-request': '1' },
    data: {
      name: 'Mapped roads',
      setting: 'A walled town',
      premise: 'Explore the courtyard.',
      tone: 'Adventure',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
    },
  });
  expect(response.ok()).toBe(true);
  const snapshot: Snapshot = await response.json();
  const [courtyard, road, tower, drain, oldCamp] = Array.from({ length: 5 }, () => randomUUID());
  snapshot.members = ['Mira', 'Rowan', 'Sir rexmen', 'Matthes'].map((name) => {
    const character = templateCharacter(name);
    return {
      id: randomUUID(),
      playerId: randomUUID(),
      playerName: name,
      characterId: randomUUID(),
      character,
      active: true,
      state: { ...initialState(character, randomUUID()), equipmentChosen: true },
    };
  });
  snapshot.myMemberId = snapshot.members[0].id;
  snapshot.scene.location = {
    id: courtyard,
    name: 'Courtyard',
    atmosphere: 'Stone paving.',
    hazard: 'No immediate threat is apparent.',
  };
  snapshot.scene.places = {
    [road]: {
      location: {
        id: road,
        name: 'Old checkpoint',
        atmosphere: 'A dusty road.',
        hazard: 'Loose stones along the roadside. No immediate threat is apparent.',
      },
      encounter: null,
      loot: [],
    },
  };
  snapshot.scene.memberLocations = {
    [snapshot.members[0].id]: courtyard,
    [snapshot.members[1].id]: road,
    [snapshot.members[2].id]: road,
    [snapshot.members[3].id]: road,
  };
  snapshot.scene.worldMap = {
    nodes: {
      [courtyard]: { id: courtyard, name: 'Courtyard', visited: true },
      [road]: { id: road, name: 'Old checkpoint', visited: true },
      [tower]: { id: tower, name: 'Watchtower', visited: false },
      [drain]: { id: drain, name: 'Drain entrance', visited: false },
      [oldCamp]: { id: oldCamp, name: 'Distant camp', visited: true },
    },
    connections: [
      { from: courtyard, to: road, label: 'Road', blocked: false, bidirectional: true },
      { from: courtyard, to: tower, label: 'Stairs', blocked: false, bidirectional: false },
      { from: courtyard, to: drain, label: 'Locked gate', blocked: true, bidirectional: true },
    ],
  };
  snapshot.history = [0, 1].map((number) => ({
    id: randomUUID(),
    number,
    phase: 'complete',
    roster: [],
    actions: [],
    rolls: [],
    result: outcomeSchema.parse({
      narration: 'The courtyard lies ahead.',
      summary: 'Routes are visible.',
      choices: [],
      changes: [],
      journal: [],
    }),
    error: null,
  }));
  snapshot.turn = { ...snapshot.history[1], id: randomUUID(), number: 2, phase: 'collecting', result: null };
  const attach = async (target: Page, screen = false) => {
    await target.route('**/api/portraits/*', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#7b9a72"/><circle cx="32" cy="28" r="18" fill="#e9c399"/><path d="M8 64Q32 20 56 64" fill="#334934"/><circle cx="25" cy="25" r="2"/><circle cx="39" cy="25" r="2"/></svg>',
      }),
    );
    await target.route(`**/api/campaigns/${snapshot.id}`, (route) =>
      route.fulfill({ json: { ...snapshot, ...(screen ? { myMemberId: null } : {}) } }),
    );
    await target.route(`**/api/campaigns/${snapshot.id}/events`, (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ ...snapshot, ...(screen ? { myMemberId: null } : {}) })}\n\n`,
      }),
    );
  };
  await attach(page);
  return { snapshot, attach, courtyard, road, tower, drain, oldCamp };
}

test('maps known routes and separate character positions on phones and the shared screen', async ({
  page,
  browser,
}) => {
  const { snapshot, attach } = await mappedTable(page);
  for (const member of snapshot.members.slice(0, 2)) member.character.portraitId = randomUUID();
  snapshot.turn!.actions = snapshot.members.slice(0, 3).map((member) => ({
    memberId: member.id,
    characterName: member.character.name,
    text: 'I look around.',
    passed: false,
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/campaign/${snapshot.id}`);
  await expect(page.getByRole('region', { name: 'World map', exact: true })).toHaveCount(0);
  snapshot.status = 'active';
  await page.reload();
  const displayContext = await browser.newContext();
  try {
    const display = await displayContext.newPage();
    await attach(display, true);
    await display.goto(`/screen/${snapshot.id}#${snapshot.displayToken}`);
    for (const view of [page, display]) {
      const map = view.getByRole('region', { name: 'World map', exact: true });
      await expect(map.getByRole('article')).toHaveCount(5);
      const current = map.getByRole('article', { name: 'Location: Courtyard', exact: true });
      await expect(current).toHaveAttribute('aria-current', 'location');
      await expect(current).toContainText('Mira');
      await expect(current).not.toContainText('Rowan');
      const selection = map.getByRole('region', { name: 'Selected location', exact: true });
      await expect(selection).toContainText('Stone paving.');
      await expect(selection).not.toContainText('Known hazard');
      await expect(selection).not.toContainText('No immediate threat');
      await expect(view.locator('.location-banner')).not.toContainText('No immediate threat');
      await expect(map.getByRole('article', { name: 'Location: Old checkpoint' })).toContainText('Rowan');
      for (const name of ['Sir rexmen', 'Matthes']) {
        await expect(map.getByRole('article', { name: 'Location: Old checkpoint' })).toContainText(name);
        await expect(current).not.toContainText(name);
      }
      const known = map.getByRole('article', { name: 'Location: Watchtower' });
      await expect(known).toContainText('Unvisited');
      await expect(map.locator('.world-map-route')).toHaveCount(3);
      await expect(map.locator('.world-map-route.blocked')).toHaveCount(1);
      for (const member of snapshot.members.slice(0, 2)) {
        const image = map.locator(`img[src="/api/portraits/${member.character.portraitId}"]`);
        await expect(image).toBeVisible();
        await expect
          .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
          .toBeGreaterThan(0);
        await expect(
          view.locator('.action-bubble').getByRole('img', {
            name: `${member.character.name} portrait`,
            exact: true,
          }),
        ).toBeVisible();
      }
      const fallback = view.locator('.action-bubble').filter({ hasText: 'Sir rexmen' });
      await expect(fallback.locator('.avatar')).toHaveText('S');
      await expect(fallback.locator('img')).toHaveCount(0);
      await map
        .getByRole('button', { name: 'Find me', exact: true })
        .or(map.getByRole('button', { name: 'Find scene', exact: true }))
        .click();
      await expect(current.locator('img')).toBeVisible();
      await map.getByRole('button', { name: 'Expand map', exact: true }).click();
      const expanded = view.getByRole('dialog', { name: 'Expanded world map', exact: true });
      await expect(
        expanded.locator(`img[src="/api/portraits/${snapshot.members[0].character.portraitId}"]`),
      ).toBeVisible();
      await expect(expanded.getByRole('region', { name: 'Selected location' })).toContainText('Stone paving.');
      await view.keyboard.press('Escape');
      await map.getByRole('button', { name: 'Fit map', exact: true }).click();
      await map.getByRole('button', { name: 'Location: Old checkpoint', exact: true }).click();
      await expect(selection).toContainText('A dusty road.');
      await expect(selection).toContainText('Known hazard: Loose stones along the roadside.');
      await expect(selection).not.toContainText('No immediate threat');
      await expect(selection).not.toContainText('Stone paving.');
      await expect(selection.getByRole('heading', { name: 'Routes', exact: true })).toBeVisible();
      await map.getByRole('button', { name: 'Fit map', exact: true }).click();
      await map.getByRole('button', { name: 'Location: Distant camp', exact: true }).click();
      await expect(selection).toContainText('No description has been recorded for this location yet.');
      await expect(selection).not.toContainText('Loose stones');
      await map.locator('summary').click();
      await expect(map.locator('.world-map-connections')).toContainText('Locked gate · Blocked');
      await expect(map.locator('.world-map-connections')).toContainText(
        'Courtyard → Watchtower · Stairs · One-way',
      );
      await view.getByRole('button', { name: 'Previous turn', exact: true }).click();
      await expect(map.getByRole('heading', { name: 'Current world map' })).toBeVisible();
      await expect(current).toContainText('Mira');
      expect(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await expect(display.getByRole('button', { name: 'Submit action' })).toHaveCount(0);
  } finally {
    await displayContext.close();
  }
});

test('keeps places and the camera stable through discoveries, navigation and expansion', async ({ page }) => {
  const { snapshot, courtyard, road, tower } = await mappedTable(page);
  snapshot.status = 'active';
  const savedMap = snapshot.scene.worldMap!;
  savedMap.positions = worldMapPositions(savedMap);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`/campaign/${snapshot.id}`);
  const map = page.getByRole('region', { name: 'World map', exact: true });
  const viewport = map.locator('.world-map-viewport');
  const canvas = map.locator('.world-map-canvas');
  const origin = map.getByRole('article', { name: 'Location: Courtyard', exact: true });
  await expect(origin).toBeVisible();
  const initialPosition = await origin.getAttribute('style');
  const transform = () =>
    canvas.evaluate((element) => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
    });
  const center = async () => {
    const box = await viewport.boundingBox();
    const camera = await transform();
    return { x: (box!.width / 2 - camera.x) / camera.zoom, y: (box!.height / 2 - camera.y) / camera.zoom };
  };
  await map.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await viewport.focus();
  await page.keyboard.press('ArrowRight');
  const cameraBeforeTurn = await canvas.getAttribute('style');
  snapshot.scene.location = { id: road, name: 'Old checkpoint', atmosphere: 'A dusty road.', hazard: '' };
  snapshot.scene.memberLocations![snapshot.members[0].id] = road;
  snapshot.scene.places![courtyard] = {
    location: { id: courtyard, name: 'Courtyard', atmosphere: 'Stone paving.', hazard: '' },
    encounter: null,
    loot: [],
  };
  delete snapshot.scene.places![road];
  const overlook = randomUUID();
  savedMap.nodes[overlook] = { id: overlook, name: 'New overlook', visited: false };
  savedMap.positions![overlook] = { x: -720, y: -420 };
  savedMap.connections.push(
    { from: road, to: tower, label: 'Service trail', blocked: false, bidirectional: true },
    { from: tower, to: overlook, label: 'Ridge', blocked: false, bidirectional: true },
  );
  snapshot.version++;
  await expect(map.getByRole('article')).toHaveCount(6, { timeout: 10_000 });
  await expect(map.getByRole('article', { name: 'Location: Old checkpoint' })).toHaveAttribute(
    'aria-current',
    'location',
  );
  expect(await canvas.getAttribute('style')).toBe(cameraBeforeTurn);
  expect(await origin.getAttribute('style')).toBe(initialPosition);
  await expect(map.locator('.world-map-selection')).toContainText('Stone paving.');
  await expect(map.locator('.world-map-route.new')).toHaveCount(2);

  await viewport.scrollIntoViewIfNeeded();
  let box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + 45, box.y + 45);
  const beforeScroll = await canvas.getAttribute('style');
  await page.mouse.wheel(0, 60);
  await expect(canvas).toHaveAttribute('style', beforeScroll!);
  // Zoom around the pointer, preserving its world coordinate.
  await viewport.scrollIntoViewIfNeeded();
  box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + 45, box.y + 45);
  const beforeWheel = await transform();
  await viewport.evaluate((element) =>
    element.addEventListener(
      'wheel',
      (event) => {
        const wheel = event as WheelEvent;
        const rect = element.getBoundingClientRect();
        Object.assign(window, {
          mapWheelPoint: { x: wheel.clientX - rect.left, y: wheel.clientY - rect.top },
        });
      },
      { once: true },
    ),
  );
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await transform()).zoom).toBeGreaterThan(beforeWheel.zoom);
  const afterWheel = await transform();
  const pointer = await page.evaluate(
    () => (window as unknown as { mapWheelPoint: { x: number; y: number } }).mapWheelPoint,
  );
  expect((pointer.x - afterWheel.x) / afterWheel.zoom).toBeCloseTo(
    (pointer.x - beforeWheel.x) / beforeWheel.zoom,
    2,
  );
  expect((pointer.y - afterWheel.y) / afterWheel.zoom).toBeCloseTo(
    (pointer.y - beforeWheel.y) / beforeWheel.zoom,
    2,
  );
  const beforeDrag = await transform();
  await page.mouse.move(box.x + 45, box.y + 45);
  await page.mouse.down();
  await page.mouse.move(box.x + 85, box.y + 75, { steps: 5 });
  await page.mouse.up();
  expect((await transform()).x).toBeCloseTo(beforeDrag.x + 40, 1);
  expect((await transform()).y).toBeCloseTo(beforeDrag.y + 30, 1);

  await map.getByRole('button', { name: 'Find me', exact: true }).click();
  await expect(map.locator('.world-map-selection')).toContainText('Old checkpoint');
  await expect(map.locator('.world-map-selection')).toContainText('A dusty road.');
  await expect(map.locator('.world-map-selection')).not.toContainText('Stone paving.');
  const beforeExpand = await center();
  const zoom = await map.getByRole('status', { name: 'Zoom level' }).textContent();
  await map.getByRole('button', { name: 'Expand map', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Expanded world map' });
  await expect(dialog).toBeVisible();
  await expect.poll(async () => (await viewport.boundingBox())!.width).toBeGreaterThan(box.width);
  expect((await center()).x).toBeCloseTo(beforeExpand.x, 2);
  expect((await center()).y).toBeCloseTo(beforeExpand.y, 2);
  await expect(dialog.getByRole('status', { name: 'Zoom level' })).toHaveText(zoom!);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(map.getByRole('button', { name: 'Expand map', exact: true })).toBeFocused();
  expect((await center()).x).toBeCloseTo(beforeExpand.x, 2);
  expect((await center()).y).toBeCloseTo(beforeExpand.y, 2);
  await map.getByRole('button', { name: 'Fit map', exact: true }).click();
  await expect(map.getByRole('button', { name: 'Location: New overlook', exact: true })).toBeInViewport();
  await map.getByRole('button', { name: 'Location: New overlook', exact: true }).click();
  await expect(map.locator('.world-map-selection')).toContainText('New overlook');
  await expect(map.locator('.world-map-selection')).toContainText('Unvisited');
  await expect(map.locator('.world-map-selection')).toContainText('This location has not been explored yet.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('fits a large world below 15% and keeps zoom controls smooth', async ({ page }) => {
  const { snapshot, courtyard, oldCamp } = await mappedTable(page);
  snapshot.status = 'active';
  const savedMap = snapshot.scene.worldMap!;
  const trail = Array.from({ length: 195 }, () => randomUUID());
  for (const [index, id] of trail.entries()) {
    savedMap.nodes[id] = { id, name: `Trail ${index + 1}`, visited: true };
    savedMap.connections.push({
      from: index ? trail[index - 1] : courtyard,
      to: id,
      label: 'Trail',
      blocked: false,
      bidirectional: true,
    });
  }
  savedMap.connections.push({
    from: courtyard,
    to: oldCamp,
    label: 'Camp trail',
    blocked: false,
    bidirectional: true,
  });
  savedMap.positions = worldMapPositions(savedMap);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/campaign/${snapshot.id}`);
  const map = page.getByRole('region', { name: 'World map', exact: true });
  const viewport = map.locator('.world-map-viewport');
  const zoom = () =>
    map
      .locator('.world-map-canvas')
      .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
  const fits = () =>
    viewport.evaluate((element) => {
      const view = element.getBoundingClientRect();
      return [...element.querySelectorAll('.world-map-tile')].every((node) => {
        const box = node.getBoundingClientRect();
        return (
          box.left >= view.left - 1 &&
          box.right <= view.right + 1 &&
          box.top >= view.top - 1 &&
          box.bottom <= view.bottom + 1
        );
      });
    });
  await expect(map.getByRole('article')).toHaveCount(200);
  await expect.poll(fits).toBe(true);
  const fitted = await zoom();
  expect(fitted).toBeGreaterThan(0);
  expect(fitted).toBeLessThan(0.15);
  await expect(map.getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled();
  await map.getByRole('button', { name: 'Zoom in', exact: true }).click();
  expect(await zoom()).toBeCloseTo(fitted * 1.25, 5);
  await map.getByRole('button', { name: 'Zoom out', exact: true }).click();
  expect(await zoom()).toBeCloseTo(fitted, 5);
  expect(await fits()).toBe(true);
  await viewport.focus();
  await page.keyboard.press('+');
  expect(await zoom()).toBeCloseTo(fitted * 1.25, 5);
  await page.keyboard.press('-');
  expect(await zoom()).toBeCloseTo(fitted, 5);
  await map.getByRole('button', { name: 'Find me', exact: true }).click();
  expect(await zoom()).toBeGreaterThanOrEqual(0.8);
  await map.getByRole('button', { name: 'Fit map', exact: true }).click();
  await expect.poll(fits).toBe(true);
  expect(await zoom()).toBeCloseTo(fitted, 5);
  await map.getByRole('button', { name: 'Expand map', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Expanded world map' })).toBeVisible();
  await map.getByRole('button', { name: 'Fit map', exact: true }).click();
  await expect.poll(fits).toBe(true);
});

test('supports touch zoom and a larger web on phones', async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    const { snapshot, courtyard, tower } = await mappedTable(page);
    snapshot.status = 'active';
    const savedMap = snapshot.scene.worldMap!;
    const places = Array.from({ length: 28 }, () => randomUUID());
    for (const [index, id] of places.entries()) {
      savedMap.nodes[id] = {
        id,
        name: index === 3 ? 'An unusually long forgotten woodland sanctuary name' : `Woodland ${index + 1}`,
        visited: index % 3 !== 0,
      };
      savedMap.connections.push({
        from: index ? places[index - 1] : courtyard,
        to: id,
        label: 'Woodland path',
        blocked: index === 4,
        bidirectional: index !== 8,
      });
      if (index % 5 === 4)
        savedMap.connections.push({
          from: id,
          to: index > 4 ? places[index - 4] : tower,
          label: 'Service trail',
          blocked: false,
          bidirectional: true,
        });
    }
    savedMap.positions = worldMapPositions(savedMap);
    await page.goto(`/campaign/${snapshot.id}`);
    const map = page.getByRole('region', { name: 'World map', exact: true });
    await expect(map.getByRole('article')).toHaveCount(33);
    const viewport = map.locator('.world-map-viewport');
    await expect(viewport).toHaveClass(/overview/);
    await viewport.scrollIntoViewIfNeeded();
    const overviewSize = await viewport.boundingBox();
    const targets = await map.locator('.world-map-node').evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      }),
    );
    for (const box of targets) {
      expect(box.width).toBeGreaterThanOrEqual(43);
      expect(box.height).toBeGreaterThanOrEqual(43);
      expect(box.left).toBeGreaterThanOrEqual(overviewSize!.x - 1);
      expect(box.right).toBeLessThanOrEqual(overviewSize!.x + overviewSize!.width + 1);
      expect(box.top).toBeGreaterThanOrEqual(overviewSize!.y - 1);
      expect(box.bottom).toBeLessThanOrEqual(overviewSize!.y + overviewSize!.height + 1);
    }
    const labels = map.locator('.world-map-node[data-overview-label] b');
    await expect(labels).toHaveCount(2);
    const labelBoxes = await labels.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
      }),
    );
    for (const label of labelBoxes) expect(label.height).toBeGreaterThanOrEqual(23);
    expect(
      labelBoxes[0].left >= labelBoxes[1].right ||
        labelBoxes[1].left >= labelBoxes[0].right ||
        labelBoxes[0].top >= labelBoxes[1].bottom ||
        labelBoxes[1].top >= labelBoxes[0].bottom,
    ).toBe(true);
    await expect(
      map.getByRole('article', { name: 'Location: Old checkpoint' }).locator('.world-map-overview-count'),
    ).toHaveText('3');
    const distant = map.getByRole('button', { name: 'Location: Woodland 28', exact: true });
    await expect(distant.locator('b')).toBeHidden();
    const overviewZoom = await map
      .locator('.world-map-canvas')
      .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
    const strokeWidth = await map
      .locator('.world-map-route:not(.selected):not(.blocked)')
      .first()
      .evaluate((element) => parseFloat(getComputedStyle(element).strokeWidth));
    expect(strokeWidth * overviewZoom).toBeCloseTo(1.25, 2);
    await map.screenshot({ path: testInfo.outputPath('phone-overview.png') });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await map.screenshot({ path: testInfo.outputPath('phone-overview-dark.png') });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    const distantPosition = await distant.locator('..').getAttribute('style');
    const target = (await distant.boundingBox())!;
    const touch = await context.newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: target.x + target.width / 2, y: target.y + target.height / 2, id: 1 }],
    });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(map.locator('.world-map-selection')).toContainText('Woodland 28');
    await expect(viewport).not.toHaveClass(/overview/);
    expect(await distant.locator('..').getAttribute('style')).toBe(distantPosition);
    await map.getByRole('button', { name: 'Find me', exact: true }).click();
    await viewport.scrollIntoViewIfNeeded();
    const box = (await viewport.boundingBox())!;
    const zoom = () =>
      map
        .locator('.world-map-canvas')
        .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
    const before = await zoom();
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: x - 30, y, id: 1 },
        { x: x + 30, y, id: 2 },
      ],
    });
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: x - 65, y, id: 1 },
        { x: x + 65, y, id: 2 },
      ],
    });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(zoom).toBeGreaterThan(before);
    expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
    await map.getByRole('button', { name: 'Fit map', exact: true }).click();
    await map.getByRole('button', { name: 'Expand map', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Expanded world map' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Fit map', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Location: Woodland 28', exact: true })).toBeInViewport();
    await dialog.getByRole('button', { name: 'Location: Woodland 28', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog.locator('.world-map-selection')).toContainText('Woodland 28');
    await page.screenshot({ path: testInfo.outputPath('phone-map.png') });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await dialog.getByRole('button', { name: 'Fit map', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('expanded-map.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await context.close();
  }
});
