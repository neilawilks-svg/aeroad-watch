// canyon-check.js
// Runs ONE check of a Canyon outlet product and sends a phone alert (via ntfy)
// when size S appears in any of your chosen colours. Designed to be run on a
// timer by GitHub Actions. It remembers what it saw last time in state.json.
//
// Needs Node 18+. No packages to install.
// Local test:  NTFY_TOPIC=your-topic node canyon-check.js --test

const fs = require('fs');

// ---------- Settings ----------
const PRODUCT_URL =
  'https://www.canyon.com/en-gb/outlet-bikes/road-bikes/aeroad-cf-slx-disc-frame-and-brake-kit/4585.html';
const PRODUCT_ID = '4585';
const TARGET_SIZE = 'S';
const COLOURS = ['Fast Lime', 'Solid Silver', 'Dark Grey', 'Pale Green', 'Stealth'];
const HEARTBEAT_HOURS = 24;   // daily "still running" ping (also keeps GitHub's timer alive)
const FAILURES_BEFORE_WARNING = 5;

// If automatic colour discovery ever stops working, open each colour on the
// site, copy the address bar link, and paste the links here instead.
const MANUAL_URLS = [];
// -------------------------------

const NTFY_TOPIC = process.env.NTFY_TOPIC;
const STATE_FILE = 'state.json';
const TEST_MODE = process.argv.includes('--test');
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
};
const SIZE_TOKEN = /^(2XS|XS|S|M|L|XL|2XL)$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { hadSize: {}, failures: 0, lastHeartbeat: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

async function get(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ');
}

// Reads the selected colour name and the sizes shown in the size picker.
function readPage(html) {
  const text = toText(html);
  const colour = text.match(/Colour:\s*(.+?)\s*Colour:/)?.[1]?.trim();

  const start = text.indexOf('Select frame size');
  const end = text.indexOf('Delivery:', start);
  if (start < 0 || end < 0) return { colour, sizes: null };

  let region = text.slice(start, end);
  const chart = region.indexOf('View size chart');
  if (chart >= 0) region = region.slice(chart + 'View size chart'.length);

  const sizes = region.split(' ').filter((t) => SIZE_TOKEN.test(t));
  return { colour, sizes: [...new Set(sizes)] };
}

async function findColourUrls() {
  if (MANUAL_URLS.length) return MANUAL_URLS;
  const html = await get(PRODUCT_URL);
  const re = new RegExp(`dwvar_${PRODUCT_ID}_pv_rahmenfarbe=([A-Za-z0-9_]+)`, 'g');
  const codes = [...new Set([...html.matchAll(re)].map((m) => m[1]))];
  return codes.map((c) => `${PRODUCT_URL}?dwvar_${PRODUCT_ID}_pv_rahmenfarbe=${c}`);
}

async function notify(title, message, url = PRODUCT_URL, priority = 'high') {
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    body: message,
    headers: { Title: title, Priority: priority, Click: url, Tags: 'bike' },
  });
  if (!res.ok) throw new Error(`ntfy returned HTTP ${res.status}`);
}

async function check(state) {
  const urls = await findColourUrls();
  if (!urls.length) throw new Error('No colour links found on the page');

  const summary = [];
  for (const url of urls) {
    await sleep(2000 + Math.random() * 3000);
    const { colour, sizes } = readPage(await get(url));
    if (!colour || sizes === null) {
      throw new Error(`Couldn't read sizes on ${url} (page layout may have changed)`);
    }
    summary.push(`${colour}: ${sizes.join(', ') || 'none'}`);

    if (COLOURS.some((c) => c.toLowerCase() === colour.toLowerCase())) {
      const has = sizes.includes(TARGET_SIZE);
      if (has && !state.hadSize[colour] && !TEST_MODE) {
        await notify(
          `Size ${TARGET_SIZE} available: ${colour}`,
          `Aeroad CF SLX frame kit in ${colour} is showing size ${TARGET_SIZE}. Tap to open.`,
          url,
          'urgent'
        );
      }
      state.hadSize[colour] = has;
    }
  }
  console.log(summary.join('\n'));
}

(async () => {
  if (!NTFY_TOPIC) {
    console.error('NTFY_TOPIC is not set. Add it as a repository secret.');
    process.exit(1);
  }

  const state = loadState();

  try {
    await check(state);
    state.failures = 0;
  } catch (e) {
    state.failures = (state.failures || 0) + 1;
    console.error(`Check failed (${state.failures} in a row): ${e.message}`);
    if (state.failures === FAILURES_BEFORE_WARNING) {
      await notify(
        'Canyon watcher has a problem',
        `${FAILURES_BEFORE_WARNING} checks in a row failed. Last error: ${e.message}`,
        PRODUCT_URL,
        'default'
      ).catch(() => {});
    }
  }

  if (TEST_MODE) {
    await notify('Canyon watcher test', 'If you can see this, alerts are working.', PRODUCT_URL, 'default');
    console.log('Test alert sent. Check your phone.');
  } else if (Date.now() - (state.lastHeartbeat || 0) > HEARTBEAT_HOURS * 3600e3) {
    const first = !state.lastHeartbeat;
    state.lastHeartbeat = Date.now();
    await notify(
      first ? 'Canyon watcher started' : 'Canyon watcher still running',
      `Checking for size ${TARGET_SIZE} in: ${COLOURS.join(', ')}.`,
      PRODUCT_URL,
      'low'
    ).catch(() => {});
  }

  saveState(state);
})();
