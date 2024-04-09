const { Pool } = require('pg');
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
        let label = await page.evaluate(el => el.innerText, link);
        innerConts.push(label);
    }
    for (var i=0; i < innerConts.length; i++) {
        console.log("innerCount parsed");
        iC = innerConts[i];
        console.dir(iC);
        if (iC.includes("Followers")) {
          followerCount = iC;
        }
    }
    console.log("Follower count determined as: ", followerCount);

    await browser.close();

    return followerCount;
}

async function recordFollowerCount(follCount, url) {
     const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false // Necessary for Heroku
        }
    });

    let client;
    try {
        client = await pool.connect();
        const date = new Date();

        const insertQuery = 'INSERT INTO x_followers (recorded_date, url, follower_count) VALUES ($1, $2, $3)';
        await client.query(insertQuery, [date, url, follCount]);
        console.log('Follower counts recorded');
    } catch (err) {
        console.error('Error recording follower counts:', err.message);
    } finally {
        if (client) {
            client.release();
        }
    }
}

const url = 'https://x.com/TFT';
scrapeFollowerCount(url)
    .then(followerCount => {
        console.log(`Follower Count: ${followerCount}`);
        recordFollowerCount(followerCount, url);
    })
    .catch(error => {
        console.error('Scraping failed:', error);
    });
