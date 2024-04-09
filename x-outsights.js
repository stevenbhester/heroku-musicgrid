const puppeteer = require('puppeteer');

async function scrapeFollowerCount(url) {
    // Launch a headless browser
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const page = await browser.newPage();
    
    // Navigate to the URL
    await page.goto(url, { waitUntil: 'networkidle0' }); 
    let followerCount = "";
  
    const links = await page.$$('a') => {
      const linkTextArr = [];
      for (var i=0; i < links.length; i++) {
        let valueHandle = await links[i].getProperty('innerText');
        let linkText = await valueHandle.jsonValue();
        const text = getText(linkText);
        if (text.includes("Followers")) {
          followerCount = text;
        }
      }
    }
    console.log("Follower count determined as: ", followerCount);

    await browser.close();

    return followerCount;
}

const url = 'https://x.com/TFT';
scrapeFollowerCount(url)
    .then(followerCount => {
        console.log(`Follower Count: ${followerCount}`);
        // Here you would add the code to insert the data into your PostgreSQL database
    })
    .catch(error => {
        console.error('Scraping failed:', error);
    });
