# 使用 Node.js 14 的官方 Docker 镜像作为基础镜像
FROM node:14

# 设置工作目录
WORKDIR /app

# 将项目文件复制到工作目录
COPY . /app

# 在容器内执行 npm install 安装依赖
RUN apt update \
    && apt install -y ffmpeg \
    && npm install

# 暴露容器的 8441 端口
EXPOSE 8441
EXPOSE 884

# 容器启动时执行 npm run start
CMD ["npm", "run", "start"]
