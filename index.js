const puppeteer = require('puppeteer');
const moment = require('moment');
const md5 = require('md5');
const express = require('express');
const _ = require('lodash');
const fs = require('fs');
const Job = require('cron').CronJob;


const MAX_TIME = 60000;
const MAX_MONTHS = 4;

const oneDay = 3600*24*1000;

let logger = require('logger').createLogger(),
	lastUpdated = 0,
	isUpdating = false;

logger.format = (level, date, message)=> {
	return moment(date).format("YYYY-MM-DD HH:mm:ss") + " | " + level.toUpperCase() + " |" + message;
};

const scrapeEvents = async ()=> {
	if (isUpdating)
		return;
	isUpdating = true;

	try {
		const startTime = Date.now();
		const browser = await puppeteer.launch({
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox'
			]
		});

		const page = await browser.newPage();

		page.on('console', msg => logger.info('PAGE LOG:', msg.text));

		const today = new Date();
		const startMonth = new Date(today.getFullYear(), today.getMonth());
		const endMonth = new Date(today.getFullYear(), today.getMonth() + MAX_MONTHS);
		const startMonthStr = moment(startMonth).format("DD-MM-YYYY");
		const endMonthStr = moment(endMonth).format("DD-MM-YYYY");

		let url = `https://www.canterbury.co.uk/events/start/${startMonthStr}/end/${endMonthStr}`;

		logger.info("Scraping from " + url);

		await page.goto(url, {waitUntil: "domcontentloaded"});

		let calendarEvents = [],
			numPages = 0;

		logger.info("Loaded first page, awaiting render");
		await page.$("a.pagination__link");

		// Loop pages until we've scraped them all.
		while (true) {
			numPages++;
			logger.info("On page " + numPages);
			// Get the next lump of events.
			calendarEvents.push(...await getEventsForPage(page));

			// Limit running time.
			if (Date.now() - startTime > MAX_TIME) {
				break;
			}

			if (!await page.$("li.pagination__item--next > a.pagination__link"))
				break;

			logger.info("Clicking for next page");
			// Go to next page
			await Promise.all([
				page.waitForNavigation({waitUntil: "domcontentloaded"}),
				page.click("li.pagination__item--next > a.pagination__link")
			]);
		}

		logger.info("Scraped " + numPages + " pages in " + (Date.now() - startTime)/1000 + " secs");

		browser.close();

		fs.writeFile(
			"/app/events.json", JSON.stringify(calendarEvents),
			()=>logger.info("Written to events.json")
		);

		lastUpdated = Date.now();
	} finally {
		isUpdating = false;
	}
};

const getEventsForPage = async (page)=> {
	let events = await page.evaluate(()=> {
		let field = ($row, name)=>{
			$el = $row.find(`strong:contains('${name}:')`).parent();
			return $el.contents().not($el.children()).text().trim();
		};
		let events = $("article.listing").toArray().map((row)=> {
			let $row = $(row),
				title = $row.find("h2.listing__heading").text().trim(),
				address = field($row, "Location")
					// Trim whitespace and commas, then join to single line with comma separator.
					.split("\n").map(d=>d.replace(/^\s+|[\s,]+$/gm, "")).join(", ");
				url = $row.find("a.listing__link").attr("href"),
				dates = field($row, "Date"),
				times = field($row, "Time"),
				description = $row.find("p.listing__summary").text().trim(),
				cost = field($row, "Cost");
			return {
				title, address, url, dates, times, description, cost
			};
		});

		return events;
	});

	//logger.info("Events raw", events);
	let calendarEvents = [];

	for (event of events) {
		let id,
			url = event.url,
			title = _.compact([
				event.title, event.description, event.address, event.cost
			]).join("\n\n"),
			dates = event.dates.split("-").map(d=>d.trim()),
			times = event.times.split("-").map(t=>t.trim()),
			startDate = moment(dates[0], "Do MMMM YYYY"),
			endDate = dates.length > 1 ? moment(dates[1], "Do MMMM YYYY") : startDate,
			startTime = moment.duration(times[0]),
			endTime = times.length > 1 ? moment.duration(times[1]) : startTime,
			currDate = startDate.clone();

		id = md5(title + url);

		do {
			if (startTime.asMilliseconds() === 0)  {
				let allDay = true,
					start = currDate.clone();
				calendarEvents.push({id, start, title, url, allDay});

			} else {
				let start = currDate.clone().add(startTime),
					calendarEvent = {id, start, title, url};
				if (endTime - startTime > 0)
					calendarEvent.end = moment(currDate).add(endTime);
				calendarEvents.push(calendarEvent);
			}

			currDate.add(1, "days");
		} while (currDate.isSameOrBefore(endDate));
	};

	return calendarEvents;
};

// Check every 5 mins if we need to update (have to do this way in case instance is frozen).
const checkUpdate = new Job("00 */5 * * * *", ()=>{
	if (Date.now() - lastUpdated > oneDay && !isUpdating) {
		logger.info("Events list is out of date, updating");
		scrapeEvents();
	}
}, null, false, "Europe/London");

// Give time for Docker to get it's network up and running.
setTimeout(()=>{
	logger.info("Performing initial scrape");
	try {
		scrapeEvents();
	} finally {
		checkUpdate.start();
	}
}, 3000);

// Web app to respond to requests.
const app = express();

// Serve static website.
app.use(express.static("/app/static", { index: 'index.html' }));
// Serve generated events json.
app.use("/events.json", express.static("/app/events.json"));
// Start the http server.
const server = app.listen(3000, () => logger.info("Canterbury Events app listening on port 3000"));

// Express doesn't respond to signals without some help.
["SIGINT", "SIGTERM"].forEach((sigName)=>{
	process.on(sigName, ()=>{
		logger.info("Received " + sigName);
		checkUpdate.stop();
		server.close(()=> logger.info("HTTP server stopped."));
	});
});

