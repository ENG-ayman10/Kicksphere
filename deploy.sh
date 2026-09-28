#!/bin/bash
if [ ! -d "Kicksphere" ]; then
    git clone -b codex/professional-foundation https://github.com/ENG-ayman10/Kicksphere.git
else
    echo "Directory exists, pulling latest..."
    cd Kicksphere
    git pull origin codex/professional-foundation
    cd ..
fi

cd Kicksphere/KickSphere-Backend
npm install --omit=dev
node server.js
