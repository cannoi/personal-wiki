FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --production
COPY . .
EXPOSE 8080
ENV PORT=8080
ENV DATA_DIR=/app/data
ENV ATTACHMENT_DIR=/app/attachments
CMD ["npm", "start"]
