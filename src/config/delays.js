// config/delays.js

module.exports = {
  MESSAGE_DELAY_MIN: process.env.MESSAGE_DELAY_MIN ? parseInt(process.env.MESSAGE_DELAY_MIN, 10) : 15000,
  MESSAGE_DELAY_MAX: process.env.MESSAGE_DELAY_MAX ? parseInt(process.env.MESSAGE_DELAY_MAX, 10) : 35000,
  REST_DELAY_MIN: process.env.REST_DELAY_MIN ? parseInt(process.env.REST_DELAY_MIN, 10) : 60000,
  REST_DELAY_MAX: process.env.REST_DELAY_MAX ? parseInt(process.env.REST_DELAY_MAX, 10) : 120000,
  MESSAGE_LIMIT_BEFORE_DELAY: process.env.MESSAGE_LIMIT_BEFORE_DELAY ? parseInt(process.env.MESSAGE_LIMIT_BEFORE_DELAY, 10) : 10
}; 