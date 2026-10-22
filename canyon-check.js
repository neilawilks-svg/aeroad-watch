// canyon-check.js
// Runs ONE check of one or more Canyon outlet products and sends a phone alert
// (via ntfy) when size S appears in any of the colours you're watching.
// Designed to be run on a timer by GitHub Actions. It remembers what it saw
// last time in state.json.
//
// Needs Node 18+. No packages to install.
// Local test:  NTFY_TOPIC=your-topic node canyon-check.js --test

const fs = require('fs');

// ---------- Settings ----------
// To watch another product, copy one of the blocks below and change it.
//   url:     the product page link (without anything after ".html")
//   id:      the number just before ".html"
//   colours: the colour names to watch, exactly as Canyon shows them,
//            or 'any' to watch every colour
const PRODUCTS = [
  {
    label: 'Aeroad frame kit (Shimano 105 Di2)',
    url: 'https://www.canyon.com/en-gb/outlet-bikes/road-bikes/aeroad-cf-slx-disc-frame-and-brake-kit/4585.html',
    id: '4585',
    colours: ['Fast Lime', 'Solid Silver', 'Dark Grey', 'Pale Green', 'Stealth', 'Dark Blue'],
  },
  {
    label: 'Aeroad frame kit (SRAM Rival AXS)',
    url: 'https://www.canyon.com/en-gb/outlet-bikes/road-bikes/aeroad-cf-slx-disc-frame-and-brake-kit/4586.html',
    id: '4586',
    colours: 'any',
  },
];
const TARGET_SIZE = 'S';
const HEARTBEAT_HOURS = 24;   // daily "still running" ping
const FAILURES_BEFORE_WARNING = 5;
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
  const colour = text
    .match(/Colour:\s*(.+?)\s*(?:Colour:|Members only|Select frame size)/)?.[1]
    ?.trim()
    .slice(0, 40);

  const start = text.indexOf('Select frame size');
  const end = text.indexOf('Delivery:', start);
  if (start < 0 || end < 0) return { colour, sizes: null };

  let region = text.slice(start, end);
  const chart = region.indexOf('View size chart');
  if (chart >= 0) region = region.slice(chart + 'View size chart'.length);

  const sizes = region.split(' ').filter((t) => SIZE_TOKEN.test(t));
  return { colour, sizes: [...new Set(sizes)] };
}

// Returns a link for every colour of a product. If the page has no colour
// links (e.g. only one colour), it just checks the product page itself.
async function findColourUrls(product) {
  const html = await get(product.url);
  const re = new RegExp(`dwvar_${product.id}_pv_rahmenfarbe=([A-Za-z0-9_]+)`, 'g');
  const codes = [...new Set([...html.matchAll(re)].map((m) => m[1]))];
  if (!codes.length) return [{ url: product.url, html }];
  return codes.map((c) => ({ url: `${product.url}?dwvar_${product.id}_pv_rahmenfarbe=${c}` }));
}

function isWatched(product, colour) {
  if (product.colours === 'any') return true;
  return product.colours.some((c) => c.toLowerCase() === colour.toLowerCase());
}

async function notify(title, message, url, priority = 'high') {
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    body: message,
    headers: { Title: title, Priority: priority, Click: url, Tags: 'bike' },
  });
  if (!res.ok) throw new Error(`ntfy returned HTTP ${res.status}`);
}

async function checkProduct(product, oldHad, newHad) {
  const pages = await findColourUrls(product);
  const summary = [];

  for (const page of pages) {
    await sleep(2000 + Math.random() * 3000);
    const html = page.html || (await get(page.url));
    const { colour, sizes } = readPage(html);
    if (!colour || sizes === null) {
      throw new Error(`Couldn't read sizes on ${page.url} (page layout may have changed)`);
    }
    summary.push(`  ${colour}: ${sizes.join(', ') || 'none'}`);

    if (isWatched(product, colour)) {
      const key = `${product.id} ${colour}`;
      const has = sizes.includes(TARGET_SIZE);
      if (has && !oldHad[key] && !TEST_MODE) {
        await notify(
          `Size ${TARGET_SIZE} available: ${colour} – ${product.label}`,
          `${product.label} in ${colour} is showing size ${TARGET_SIZE}. Tap to open.`,
          page.url,
          'urgent'
        );
      }
      newHad[key] = has;
    }
  }
  console.log(`${product.label}\n${summary.join('\n')}`);
}

(async () => {
  if (!NTFY_TOPIC) {
    console.error('NTFY_TOPIC is not set. Add it as a repository secret.');
    process.exit(1);
  }

  const state = loadState();
  const newHad = {};

  try {
    for (const product of PRODUCTS) {
      await checkProduct(product, state.hadSize || {}, newHad);
    }
    state.hadSize = newHad;
    state.failures = 0;
  } catch (e) {
    state.failures = (state.failures || 0) + 1;
    console.error(`Check failed (${state.failures} in a row): ${e.message}`);
    if (state.failures === FAILURES_BEFORE_WARNING) {
      await notify(
        'Canyon watcher has a problem',
        `${FAILURES_BEFORE_WARNING} checks in a row failed. Last error: ${e.message}`,
        PRODUCTS[0].url,
        'default'
      ).catch(() => {});
    }
  }

  const watching = PRODUCTS.map(
    (p) => `${p.label}: ${p.colours === 'any' ? 'any colour' : p.colours.join(', ')}`
  ).join('\n');

  if (TEST_MODE) {
    await notify('Canyon watcher test', 'If you can see this, alerts are working.', PRODUCTS[0].url, 'default');
    console.log('Test alert sent. Check your phone.');
  } else if (Date.now() - (state.lastHeartbeat || 0) > HEARTBEAT_HOURS * 3600e3) {
    const first = !state.lastHeartbeat;
    state.lastHeartbeat = Date.now();
    await notify(
      first ? 'Canyon watcher started' : 'Canyon watcher still running',
      `Checking for size ${TARGET_SIZE} in:\n${watching}`,
      PRODUCTS[0].url,
      'low'
    ).catch(() => {});
  }

  saveState(state);
})();
