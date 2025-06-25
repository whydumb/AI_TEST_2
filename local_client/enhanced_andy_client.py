#!/usr/bin/env python3
"""
Enhanced Andy API Local Client
Joins the compute pool with VRAM tracking and enhanced system monitoring
"""

import requests
import json
import time
import uuid
import psutil
import platform
import threading
from datetime import datetime

class AndyAPIClient:
    def __init__(self, server_url="https://mindcraft.riqvip.dev", ollama_url="http://localhost:11434"):
        self.server_url = server_url.rstrip('/')
        self.ollama_url = ollama_url.rstrip('/')
        self.host_id = None
        self.running = False
        self.ping_thread = None
        
        # System info
        self.system_info = self.get_system_info()
        print(f"System Info: {json.dumps(self.system_info, indent=2)}")
    
    def get_system_info(self):
        """Get comprehensive system information"""
        info = {
            "cpu_cores": psutil.cpu_count(logical=False),
            "cpu_threads": psutil.cpu_count(logical=True),
            "ram_total_gb": round(psutil.virtual_memory().total / (1024**3), 2),
            "platform": platform.system(),
            "python_version": platform.python_version()
        }
        
        # Try to get GPU info (basic detection)
        try:
            import GPUtil
            gpus = GPUtil.getGPUs()
            if gpus:
                info["gpu_count"] = len(gpus)
                info["vram_total_gb"] = sum(gpu.memoryTotal / 1024 for gpu in gpus)
                info["gpu_names"] = [gpu.name for gpu in gpus]
            else:
                info["gpu_count"] = 0
                info["vram_total_gb"] = 0
        except ImportError:
            # Fallback - try nvidia-ml-py
            try:
                import pynvml
                pynvml.nvmlInit()
                gpu_count = pynvml.nvmlDeviceGetCount()
                info["gpu_count"] = gpu_count
                
                total_vram = 0
                gpu_names = []
                for i in range(gpu_count):
                    handle = pynvml.nvmlDeviceGetHandleByIndex(i)
                    mem_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
                    name = pynvml.nvmlDeviceGetName(handle).decode('utf-8')
                    
                    total_vram += mem_info.total / (1024**3)
                    gpu_names.append(name)
                
                info["vram_total_gb"] = round(total_vram, 2)
                info["gpu_names"] = gpu_names
                
            except (ImportError, Exception):
                # No GPU info available
                info["gpu_count"] = 0
                info["vram_total_gb"] = 0
                info["gpu_names"] = []
        
        return info
    
    def get_current_usage(self):
        """Get current system usage metrics"""
        usage = {
            "cpu_usage_percent": psutil.cpu_percent(interval=1),
            "ram_used_gb": round(psutil.virtual_memory().used / (1024**3), 2),
            "timestamp": datetime.now().isoformat()
        }
        
        # Try to get current VRAM usage
        try:
            import pynvml
            pynvml.nvmlInit()
            total_vram_used = 0
            
            for i in range(pynvml.nvmlDeviceGetCount()):
                handle = pynvml.nvmlDeviceGetHandleByIndex(i)
                mem_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
                total_vram_used += mem_info.used / (1024**3)
            
            usage["vram_used_gb"] = round(total_vram_used, 2)
            
        except:
            # Estimate VRAM usage (very rough)
            usage["vram_used_gb"] = round(self.system_info.get("vram_total_gb", 0) * 0.3, 2)
        
        return usage
    
    def discover_ollama_models(self):
        """Discover available models from Ollama"""
        try:
            response = requests.get(f"{self.ollama_url}/api/tags", timeout=10)
            if response.status_code == 200:
                data = response.json()
                models = []
                
                for model in data.get('models', []):
                    model_info = {
                        "name": model.get('name', ''),
                        "size": model.get('size', 0),
                        "modified_at": model.get('modified_at', ''),
                        "quantization": "auto-detected",
                        "context_length": 8192  # Default, could be improved
                    }
                    models.append(model_info)
                
                print(f"Discovered {len(models)} models from Ollama")
                return models
            else:
                print(f"Failed to get models from Ollama: {response.status_code}")
                return []
                
        except Exception as e:
            print(f"Error discovering Ollama models: {e}")
            return []
    
    def join_pool(self):
        """Join the Andy API compute pool"""
        models = self.discover_ollama_models()
        
        if not models:
            print("No models found! Make sure Ollama is running and has models.")
            return False
        
        usage = self.get_current_usage()
        
        payload = {
            "models": models,
            "max_clients": 2,  # Conservative default
            "endpoint": self.ollama_url,
            "capabilities": ["text"],  # Could be enhanced to detect vision models
            **self.system_info,
            **usage
        }
        
        try:
            response = requests.post(
                f"{self.server_url}/api/andy/join_pool",
                json=payload,
                timeout=30
            )
            
            if response.status_code == 200:
                data = response.json()
                self.host_id = data["host_id"]
                print(f"✅ Successfully joined pool!")
                print(f"   Host ID: {self.host_id}")
                print(f"   Pool size: {data['pool_size']}")
                print(f"   Ping interval: {data['ping_interval']}s")
                return True
            else:
                print(f"❌ Failed to join pool: {response.status_code}")
                print(f"   Response: {response.text}")
                return False
                
        except Exception as e:
            print(f"❌ Error joining pool: {e}")
            return False
    
    def leave_pool(self):
        """Leave the Andy API compute pool"""
        if not self.host_id:
            return True
        
        try:
            response = requests.post(
                f"{self.server_url}/api/andy/leave_pool",
                json={"host_id": self.host_id},
                timeout=10
            )
            
            if response.status_code == 200:
                print("✅ Successfully left pool")
                return True
            else:
                print(f"❌ Failed to leave pool: {response.status_code}")
                return False
                
        except Exception as e:
            print(f"❌ Error leaving pool: {e}")
            return False
    
    def ping_pool(self):
        """Send ping with current status"""
        if not self.host_id:
            return False
        
        usage = self.get_current_usage()
        
        payload = {
            "host_id": self.host_id,
            "status": "active",
            "current_load": 0,  # Would need to track actual load
            **usage
        }
        
        try:
            response = requests.post(
                f"{self.server_url}/api/andy/ping_pool",
                json=payload,
                timeout=10
            )
            
            if response.status_code == 200:
                return True
            else:
                print(f"Ping failed: {response.status_code}")
                return False
                
        except Exception as e:
            print(f"Ping error: {e}")
            return False
    
    def ping_worker(self):
        """Background thread for periodic pings"""
        while self.running:
            if self.ping_pool():
                print(f"📡 Ping sent - {datetime.now().strftime('%H:%M:%S')}")
            else:
                print(f"❌ Ping failed - {datetime.now().strftime('%H:%M:%S')}")
            
            time.sleep(15)  # Ping every 15 seconds
    
    def start(self):
        """Start the client"""
        print("🚀 Starting Andy API Enhanced Client...")
        print(f"Server: {self.server_url}")
        print(f"Ollama: {self.ollama_url}")
        
        if not self.join_pool():
            return False
        
        self.running = True
        self.ping_thread = threading.Thread(target=self.ping_worker, daemon=True)
        self.ping_thread.start()
        
        print("✅ Client started successfully!")
        print("Press Ctrl+C to stop...")
        
        try:
            while self.running:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\n🛑 Stopping client...")
            self.stop()
        
        return True
    
    def stop(self):
        """Stop the client"""
        self.running = False
        if self.ping_thread:
            self.ping_thread.join(timeout=5)
        
        self.leave_pool()
        print("👋 Client stopped")

def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="Enhanced Andy API Local Client")
    parser.add_argument("--server", default="https://mindcraft.riqvip.dev", 
                       help="Andy API server URL")
    parser.add_argument("--ollama", default="http://localhost:11434",
                       help="Ollama server URL")
    
    args = parser.parse_args()
    
    client = AndyAPIClient(server_url=args.server, ollama_url=args.ollama)
    client.start()

if __name__ == "__main__":
    main()
