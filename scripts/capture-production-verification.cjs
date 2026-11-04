async (page) => {
  const outputDir = 'public/assets/m2-2-production';

  console.log('Beginning M2.2 Production Visual Verification Capture to:', outputDir);
  await page.setViewportSize({ width: 1920, height: 1080 });

  // Helper to wait for WebGL frames and settle
  const waitSettle = async (ms = 400) => {
    await page.evaluate((delay) => new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(resolve, delay);
        });
      });
    }), ms);
  };

  const capture = async (filename) => {
    const fullPath = `${outputDir}/${filename}`;
    await page.screenshot({ path: fullPath, fullPage: false });
    console.log(`Captured ${filename}`);
  };

  // Collapse dock for clean full-canvas view
  await page.evaluate(() => {
    if (window.__M21_LAB__) {
      window.__M21_LAB__.setDockCollapsed(true);
    }
  });

  const themes = ['tactical', 'daylight', 'dusk', 'blueprint'];
  const zoomConfigs = [
    { name: 'overview', zoom: 1.0 },
    { name: 'medium', zoom: 3.0 },
    { name: 'close', zoom: 8.0 }
  ];

  // =========================================================================
  // SCENARIO 1: Synthetic Switchyard
  // =========================================================================
  console.log('--- Scenario 1: Synthetic Switchyard ---');
  await page.evaluate(() => {
    window.__M21_LAB__.loadSwitchyard('overview', 1.0, 45);
  });
  await waitSettle(600);

  for (const z of zoomConfigs) {
    for (const th of themes) {
      await page.evaluate(({ zLevel, themeId }) => {
        window.__M21_LAB__.setTheme(themeId);
        window.__M21_LAB__.setCameraPose([0, 0, 0], zLevel, 45);
      }, { zLevel: z.zoom, themeId: th });
      await waitSettle(250);
      await capture(`switchyard_${z.name}_${th}.png`);
    }
  }

  // Switchyard Detailed Close-ups
  console.log('Capturing Switchyard Detailed Zones...');
  // Dense station throat
  await page.evaluate(() => {
    window.__M21_LAB__.setTheme('tactical');
    window.__M21_LAB__.jumpToZone('station_throat', 8.0, 45);
  });
  await waitSettle(300);
  await capture('switchyard_throat_close_tactical.png');

  // Scissors crossover
  await page.evaluate(() => {
    window.__M21_LAB__.setTheme('tactical');
    window.__M21_LAB__.jumpToZone('scissors_crossover', 8.0, 45);
  });
  await waitSettle(300);
  await capture('switchyard_scissors_close_tactical.png');

  // Single turnout in daylight
  await page.evaluate(() => {
    window.__M21_LAB__.setTheme('daylight');
    window.__M21_LAB__.jumpToZone('single_turnout', 8.0, 45);
  });
  await waitSettle(300);
  await capture('switchyard_turnout_close_daylight.png');

  // =========================================================================
  // SCENARIO 2: Real Station Hengelo OSM Data
  // =========================================================================
  console.log('--- Scenario 2: Station Hengelo OSM Data ---');
  await page.evaluate(async () => {
    await window.__M21_LAB__.loadHengelo([0, 0, 0], 1.0, 45);
  });
  await waitSettle(1000);

  for (const z of zoomConfigs) {
    for (const th of themes) {
      await page.evaluate(({ zLevel, themeId }) => {
        window.__M21_LAB__.setTheme(themeId);
        window.__M21_LAB__.setCameraPose([0, 0, 0], zLevel, 45);
      }, { zLevel: z.zoom, themeId: th });
      await waitSettle(250);
      await capture(`hengelo_${z.name}_${th}.png`);
    }
  }

  // Hengelo station throat close-up
  await page.evaluate(() => {
    window.__M21_LAB__.setTheme('tactical');
    window.__M21_LAB__.setCameraPose([120, 0, -20], 8.0, 55);
  });
  await waitSettle(300);
  await capture('hengelo_throat_close_tactical.png');

  // =========================================================================
  // SCENARIO 3: Real Amsterdam Centraal OSM Data
  // =========================================================================
  console.log('--- Scenario 3: Amsterdam Centraal OSM Data ---');
  await page.evaluate(async () => {
    await window.__M21_LAB__.loadAmsterdam([0, 0, 0], 1.0, 45);
  });
  await waitSettle(1000);

  for (const z of zoomConfigs) {
    for (const th of themes) {
      await page.evaluate(({ zLevel, themeId }) => {
        window.__M21_LAB__.setTheme(themeId);
        window.__M21_LAB__.setCameraPose([0, 0, 0], zLevel, 45);
      }, { zLevel: z.zoom, themeId: th });
      await waitSettle(250);
      await capture(`amsterdam_${z.name}_${th}.png`);
    }
  }

  // Amsterdam Railway Bridges & Approaches
  console.log('Capturing Amsterdam Bridges & Approaches...');
  // Medium zoom showing western approach viaducts & bridge structures
  await page.evaluate(() => {
    window.__M21_LAB__.setTheme('tactical');
    window.__M21_LAB__.setCameraPose([-320, 0, -80], 3.2, 60);
  });
  await waitSettle(350);
  await capture('amsterdam_bridges_medium_tactical.png');

  // Close zoom showing elevated railway bridge substructure & parapets
  await page.evaluate(() => {
    window.__M21_LAB__.setTheme('tactical');
    window.__M21_LAB__.setCameraPose([-280, 0, -70], 8.0, 60);
  });
  await waitSettle(350);
  await capture('amsterdam_bridges_close_tactical.png');

  console.log('All M2.2 Production Visual Verification screenshots captured successfully!');
}
