#!/bin/bash
#./ttyd -W -p 8020 zsh
sudo apt update
sudo apt install -y ttyd
#ttyd -W -t eZmodem=true -p 8020 tmux new-session -A -s codex_1
#ttyd -W -p 8020 bash


ttyd -W -t eZmodem=true -p 8020 zellij attach ai --create
