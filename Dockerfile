FROM node:slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm i
COPY . .

ENTRYPOINT [ "/usr/local/bin/npm", "start" ]
