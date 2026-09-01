const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));
  page.on('requestfailed', request => console.log('REQUEST FAILED:', request.url(), request.failure().errorText));

  await page.goto('http://localhost:3000/admin.html?token=PR29', { waitUntil: 'networkidle0' });
  
  const status = await page.$eval('#statusText', el => el.textContent);
  console.log('Status Text:', status);
  
  await browser.close();
})();
