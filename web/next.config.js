/** @type {import('next').NextConfig} */
module.exports = {
  // Static export served at bigdogflip.com/scheduling/ by
  // ../server/server.mjs. trailingSlash makes every page an index.html
  // under its own folder, which is what that server looks for.
  output: 'export',
  basePath: '/scheduling',
  trailingSlash: true,
  images: { unoptimized: true },
}
