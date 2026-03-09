#!/bin/sh
npx prisma db push
exec node dist/src/main.js
