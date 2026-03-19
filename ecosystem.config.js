module.exports = {
  apps: [{
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
  }]
};
