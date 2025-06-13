# Use an official Node.js runtime as a parent image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
# A wildcard is used to ensure both package.json and package-lock.json are copied
# This uses a cache layer, so npm install only runs if package*.json changes
COPY package*.json ./

# Install application dependencies
RUN npm install

# Install Chromium and its dependencies
RUN apk add --no-cache chromium nss freetype freetype-dev harfbuzz ca-certificates

# Set the PUPPETEER_EXECUTABLE_PATH for whatsapp-web.js to find Chromium
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium-browser"

# Copy the rest of the application code
COPY . .

# Expose the port your app runs on
# This should match the PORT in your src/server.js (default 3000)
EXPOSE 3000

# Define environment variables that your application uses
# These are default values and can be overridden by docker-compose.yml or runtime env vars
ENV PORT=3000
ENV REDIS_HOST=redis
ENV REDIS_PORT=6379

# Command to run the application
CMD [ "npm", "start" ]