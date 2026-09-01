const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));

  await page.goto('http://localhost:3000/admin.html?token=PR29', { waitUntil: 'networkidle0' });
  
  // Now evaluate script to manually trigger updateAuthRequests
  await page.evaluate(() => {
    updateAuthRequests([{ username: 'TestUser', code: '9999' }]);
  });
  
  const authHtml = await page.$eval('#authRequestsList', el => el.innerHTML);
  console.log('AUTH HTML:', authHtml);
  
  await browser.close();
})();
