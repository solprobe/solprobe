module.exports = {
  apps: [
    {
      name: "solprobe",
      script: "./start.sh",
      interpreter: "bash",
      restart_delay: 3000,
      max_restarts: 20,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
      log_file: "logs/combined.log",
      error_file: "logs/error.log",
      time: true,
    },
    {
      name: "solprobe-buyback",
      script: "./scripts/buyback.ts",
      interpreter: "npx",
      interpreter_args: "tsx",
      restart_delay: 10000,
      max_restarts: 10,
      watch: false,
      env: {
        NODE_ENV: "production",
        DRY_RUN: "true",
      },
      log_file: "logs/buyback-combined.log",
      error_file: "logs/buyback-error.log",
      time: true,
    },
  ],
};
