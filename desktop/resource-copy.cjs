const fs = require('node:fs/promises');
async function copyIfChanged(source, destination) {
  if (!(await fs.stat(source)).isFile()) return true;
  try {
    const [before, after] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
    return !before.equals(after);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}
module.exports = { copyIfChanged };
