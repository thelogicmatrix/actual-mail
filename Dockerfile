FROM node:22-alpine
WORKDIR /app

# Dependencies before source, so a code change does not re-run the install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# src/load/ comes along inside src/ — one package, so one install and one COPY per tree.
COPY src/ ./src/
COPY bin/ ./bin/

# Part 1 is the default. Part 2 is reached with
#   --entrypoint node ... /app/bin/actual-mail-load.js
ENTRYPOINT ["node", "/app/bin/actual-mail.js"]
