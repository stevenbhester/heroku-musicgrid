const puppeteer = require('puppeteer');

async function scrapeFollowerCount(url) {
    // Launch a headless browser
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_EXECUTABLE_PATH || process.env.GOOGLE_CHROME_BIN,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    
    // Navigate to the URL
    console.log("Navigating to url");
    await page.goto(url, { waitUntil: 'networkidle0' }); 
    let followerCount = "";
  
    let links = await page.$$('a');
    console.log("links fetched");
    console.dir(links);
    let innerConts = [];

    for (const link of links) {
        let label = await this.page.evaluate(el => el.innerText, link);
        innerConts.push(label);
    }
    for (var i=0; i < innerConts.length; i++) {
        console.log("innerCount parsed");
        iC = innerConts[i]
        console.dir(iC);
        if (iC.includes("Followers")) {
          followerCount = text;
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
