const puppeteer = require('puppeteer');
const moment = require('moment');
const md5 = require('md5');
const express = require('express');
const _ = require('lodash');
const fs = require('fs');
const Job = require('cron').CronJob;


const MAX_TIME = 60000;

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
	
		await page.goto(
			'http://www.canterbury.co.uk/events/thedms.aspx?dms=12&msg=', 
			{waitUntil: 'networkidle0'}
		);
	
		let calendarEvents = [],
			numPages = 0;
	
		logger.info("Loaded first page, awaiting render");
		await page.$("a.pagenextbrowsedata12")
	
		// Loop pages until we've scraped them all.
		while (true) {
			numPages++;
			logger.info("On page " + numPages + ". Awaiting loading spinner");
			// Ensure loading spinner is gone.
			await page.waitForSelector("#loadinganimation", {hidden: true});
			logger.info("Scraping events");
			// Get the next lump of events.
			calendarEvents.push(...await getEventsForPage(page));
	
			// Limit running time.
			if (Date.now() - startTime > MAX_TIME) {
				break
			}
	
			if (!await page.$("a.pagenextbrowsedata12"))
				break;
	
			logger.info("Clicking for next page");
			// Go to next page
			await page.click("a.pagenextbrowsedata12");
			logger.info("Awaiting navigation");
			// Wait for navigation to have finished.
			await page.waitForNavigation({waitUntil: "networkidle0"});
		}
	
		logger.info("Scraped " + numPages + " pages in " + (Date.now() - startTime)/1000 + " secs");
	
		browser.close();
	
		fs.writeFile(
			"/app/events.json", JSON.stringify(calendarEvents),
			()=>logger.info("Written to events.json")
		);
		
		lastUpdated = Date.now()
	} finally {
		isUpdating = false;
	}
};

const getEventsForPage = async (page)=> {
	let events = await page.evaluate(()=> {
		let events = $(".thedmsBrowseRow").find(".regularScreenOnly").toArray().map((row)=> {
			let $row = $(row),
				$title = $row.find(".thedmsBrowseH2Background"),
				title = $title.not($title.children()).text().trim(),
				address = $row.find(".thedmsAddress").text().trim(),
				phone = $row.find(".thedmsPhone").text().trim(),
				url = $row.find(".thedmsWebsite").text().trim(),
				$date = $row.find(".thedmsEventDate"),
				$description = $row.find(".thedmsDescription"),
				description = $description.text().trim(),
				dates = $date.find("strong  > a").text().trim(),
				times = $date.find("ul > li").text().trim();
			return {
				title, address, phone, url, dates, times, description
			};
		});

		return events;
	});

//	logger.info("Events raw", events);
	let calendarEvents = [];

	for (event of events) {
		let id,
			currDate,
			endDate,
			dateMatch,
			title = _.compact([
				event.title, event.description, event.address, event.phone
			]).join("\n\n"),
			url = "http://" + event.url,
			distinctTimes = event.times.split(",").map((time)=>time.trim()).map(
				(time)=> time.split("to").map((time)=>time.trim())
			);

		if (dateMatch = datePatterns.singleDate.exec(event.dates)) {
			currDate = moment(dateMatch.slice(1).join(" "), "D MMM YYYY");
			endDate = moment(currDate);

		} else if (dateMatch = datePatterns.singleMonth.exec(event.dates)) {
			currDate = moment([dateMatch[1], ...dateMatch.slice(3, 5)].join(" "), "D MMM YYYY");
			endDate = moment(dateMatch.slice(2, 5).join(" "), "D MMM YYYY");

		} else if (dateMatch = datePatterns.multiMonth.exec(event.dates)) {
			currDate = moment(
				[...dateMatch.slice(1,3), dateMatch[5]].join(" "), "D MMM YYYY"
			);
			endDate = moment(dateMatch.slice(2, 5).join(" "), "D MMM YYYY");

		} else if (dateMatch = datePatterns.multiYear.exec(event.dates)) {
			currDate = moment(dateMatch.slice(1, 4).join(" "), "D MMM YYYY");
			endDate = moment(dateMatch.slice(4, 7).join(" "), "D MMM YYYY");
		} else {
			throw new Error("'" + event.dates + "' did not match any date formats")
		}

		id = md5(title + url);

		do {
			if (!distinctTimes[0][0])  {
				let start = moment(currDate),
					allDay = true;
				calendarEvents.push({id, start, title, url, allDay})

			} else {
				for (let times of distinctTimes) {
					let start = moment(currDate).add(moment.duration(times[0])),
						calendarEvent = {id, start, title, url};
					if (times.length > 1)
						calendarEvent.end = moment(currDate).add(moment.duration(times[1]));
					calendarEvents.push(calendarEvent)
				}
			}

			currDate.add(1, "days");
		} while (currDate.isSameOrBefore(endDate))
	};

	return calendarEvents;
};

//Date patterns to match.
const datePatterns = {
	singleDate: new RegExp(
		"^[A-Z][a-z][a-z] ([0-9][0-9]?) ([A-Z][a-z][a-z]) ([0-9][0-9][0-9][0-9])$"
	),
	singleMonth: new RegExp(
		"^[A-Z][a-z][a-z] ([0-9][0-9]?) - " +
		"[A-Z][a-z][a-z] ([0-9][0-9]?) ([A-Z][a-z][a-z]) ([0-9][0-9][0-9][0-9])$"
	),
	multiMonth: new RegExp(
		"^[A-Z][a-z][a-z] ([0-9][0-9]?) ([A-Z][a-z][a-z]) - " +
		"[A-Z][a-z][a-z] ([0-9][0-9]?) ([A-Z][a-z][a-z]) ([0-9][0-9][0-9][0-9])$"
	),
	multiYear: new RegExp(
		"^[A-Z][a-z][a-z] ([0-9][0-9]?) ([A-Z][a-z][a-z]) ([0-9][0-9][0-9][0-9]) - " +
		"[A-Z][a-z][a-z] ([0-9][0-9]?) ([A-Z][a-z][a-z]) ([0-9][0-9][0-9][0-9])$"
	)

};

const oneDay = 3600*24*1000;

// Check every 5 mins if we need to update (have to do this way in case instance is frozen).
const checkUpdate = new Job("00 */5 * * * *", ()=>{
	if (Date.now() - lastUpdated > oneDay && !isUpdating) {
		logger.info("Events list is out of date, updating");
		scrapeEvents();
	}
}, null, true, "Europe/London", null, true);

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



