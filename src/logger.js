function log(label, data) {
  const time = new Date().toISOString().substring(11, 23);
  if (data !== undefined) {
    console.log(
      `[${time}] ${label}`,
      typeof data === "object" ? JSON.stringify(data) : data,
    );
  } else {
    console.log(`[${time}] ${label}`);
  }
}

module.exports = { log };
