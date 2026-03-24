-- CreateTable
CREATE TABLE "Services" (
    "idx" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "serviceName" TEXT NOT NULL,
    "servicePort" INTEGER NOT NULL,
    "serviceStatus" TEXT NOT NULL,
    "serviceLastOnline" DATETIME NOT NULL
);
