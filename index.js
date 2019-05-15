var gm = require('gm').subClass({imageMagick: true});
require('dotenv').config();
const dogapi = require('dogapi');
const axios = require('axios');
const util = require('util');
const puppeteer = require('puppeteer'); 
const rimraf = require('rimraf')
const argv = require('yargs').argv

// default values and valid options via https://docs.datadoghq.com/api/?lang=bash#create-embed
const CLI_ARG_DEFAULTS = {
  't': {'default': "1_hour", 'options': ["1_hour", "4_hours", "1_day", "2_days", "1_week"]},
  'a': {'default': "sum", 'options': ["sum","avg","min","max"]},
  'n': {'default': "timeseries_output"}
}

const example_query = "system.net.bytes_rcvd{host:comp10929.home}"

//initialize dogapi
let config = { dd_options: { api_key: process.env.API_KEY, app_key: process.env.APP_KEY}, geonames_username: process.env.USERNAME};
dogapi.initialize(config.dd_options)

let init = async (args) => {
	try {

    //check for valid arguments and raise errors or warnings if not set
    if(args.q === undefined) {
      throw(`required: include q argument with an example query ex: node index.js --q=${example_query}`)
    }

    let arg_input = Object.keys(CLI_ARG_DEFAULTS).reduce( (arg_input, arg) => {
      if (args[arg] === undefined || (CLI_ARG_DEFAULTS[arg]['options'] ? CLI_ARG_DEFAULTS[arg]['options'].indexOf(args[arg]) === -1 : args[arg] === '')) {
        console.warn(`no valid --${arg} argument supplied, defaulting to ${CLI_ARG_DEFAULTS[arg]['default']} --${arg}=${CLI_ARG_DEFAULTS[arg]['default']}`)
        
        arg_input[arg] = CLI_ARG_DEFAULTS[arg]['default']
      } else {
        arg_input[arg] = args[arg]
      }
      return arg_input
    }, {'q': args.q})


    //make create embed request
    let graphJSON = {
      viz: "timeseries",
      requests: [
        {
          q: arg_input['q'],
          aggregator: arg_input['a'],
          conditional_formats: [],
          type: "line"
        }
      ]
    }

    let options = {
      timeframe: arg_input['t'],
      size: "medium",
      legend: "yes",
      title: "dd_gif_maker-"+arg_input['q']
    };

    let createEmbed = util.promisify(dogapi.embed.create)
    let revokeEmbed = util.promisify(dogapi.embed.revoke)
    let create_response = await createEmbed(graphJSON, options)

    //ensure valid response and save embed id
    if (create_response.errors !== undefined && create_response.errors.length > 0) {
      throw(`dogapi create embed error ${create_response.errors.toString()}`)
    }

    let embed_id = create_response.embed_id

    console.log('dd embed id: ', embed_id)

    //init headless chrome with embed html allow iframe to load
    let html_snippet = create_response.html
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    await page.setViewport({ width: 600, height: 300 })
    await page.setContent(html_snippet)
    await page.waitFor(3000)

    // get timeseries line details from iframe
    // split by each tick
    let childFrame = undefined
    childFrame = page.mainFrame().childFrames()[0]

    let textFeed = await childFrame.$$eval('path.series', pElements => pElements[0].getAttribute('d').split(','))
    
    let storageObject = {}
    textFeed.forEach( (_point,index) => {
        storageObject[index] = textFeed.slice(0,index+1)
    })

    //iterate and take snapshot of html for each timeseries tick
    var i = 0
    for (let value of textFeed) {
        // format this with padding so imagemagick iterates correctly
        let temp_i = (i+"").padStart(3,"0")
        await childFrame.$$eval('path.series', (pElements,storageObjectString) => {pElements[0].setAttribute('d', storageObjectString)},storageObject[i].toString())
        await page.screenshot({ path: `./snapshots/snap_${temp_i}.png`, fullPage: true })
        i++
    }

    //cleanup headless chrome, revoke embed
    await browser.close()
    let revoke_response = await revokeEmbed(embed_id)

    //ensure valid revoke embed response warn if not revoked
    if (revoke_response.errors !== undefined && revoke_response.errors.length > 0) {
      console.warn(`dogapi revoke embed error ${revoke_response.errors.toString()}`)
    } else {
      console.log(`successfully revoked dd embed id ${embed_id}`)
    }

    // make gif then clean up snapshots
    function makeGif() {
      return new Promise( function(resolve,reject) {
        try {
          // TODO: determine better way to manage fps, some stray screenshots still out of order
          gm().command('convert').in('./snapshots/snap_*.png').in('-delay',"20").write(`${arg_input['n']+Date.now()}.gif`, function(err) {
              if(err) {
                throw(err);
              }
              resolve();
            });
        } catch (err) {
            reject(err);
        }
      })
    }

    makeGif().then( (_x) => {
      console.log(`done creating ${arg_input[`n`]}.gif`)
      rimraf('./snapshots/*', function () { console.log(`done deleting snapshot pngs`); });
    }).catch( (err) => {
      console.warn('snapshots not deleted because there was an error', err)
    })
	} catch(error) {
    console.log(error)
	}
   
}

init(argv)