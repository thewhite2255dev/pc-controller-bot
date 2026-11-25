module.exports = {
  apps: [
    {
      name: "z-ctrl",
      cwd: "C:\\pc-controller-bot",
      script: "dist/bot.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      windowsHide: true,
      kill_timeout: 5000,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
