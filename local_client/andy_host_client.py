#!/usr/bin/env python3
"""
Andy API Host Client
A simple client script for joining the Andy API compute pool.

This script helps you:
1. Register your host with the Andy API pool
2. Monitor your host's performance
3. Automatically detect available Ollama models
4. Send health pings to maintain pool membership

Usage:
    python andy_host_client.py --url http://localhost:11434 --name "my-host" --andy-url https://mindcraft.riqvip.dev

Optional model filtering:
    python andy_host_client.py --url http://localhost:11434 --name "my-host" --andy-url https://mindcraft.riqvip.dev --allowed-models "llama3:8b" "mistral:7b"

Requirements:
    pip install requests ollama-python
"""

import argparse
import requests
import time
import json
import sys
import logging
from typing import Dict, List, Optional

try:
    import ollama
    OLLAMA_AVAILABLE = True
except ImportError:
    OLLAMA_AVAILABLE = False
    print("Warning: ollama-python not installed. Run: pip install ollama-python")

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class AndyHostClient:
    def __init__(self, ollama_url: str, host_name: str, andy_api_url: str, capabilities: Optional[List[str]] = None, allowed_models: Optional[List[str]] = None):
        self.ollama_url = ollama_url.rstrip('/')
        self.host_name = host_name
        self.andy_api_url = andy_api_url.rstrip('/')
        self.capabilities = capabilities or []
        self.allowed_models = allowed_models  # Only these models will be sent to the server
        self.host_id = None
        self.registered = False
        
        # Initialize Ollama client if available
        if OLLAMA_AVAILABLE:
            try:
                self.ollama_client = ollama.Client(host=ollama_url)
            except Exception as e:
                logger.error(f"Failed to initialize Ollama client: {e}")
                self.ollama_client = None
        else:
            self.ollama_client = None

    def detect_models(self) -> List[str]:
        """Detect available models from Ollama"""
        if not self.ollama_client:
            logger.warning("Ollama client not available for model detection")
            return []
        
        try:
            models = self.ollama_client.list()
            model_names = [model['name'] for model in models['models']]
            logger.info(f"Detected {len(model_names)} models: {model_names}")
            return model_names
        except Exception as e:
            logger.error(f"Failed to detect models: {e}")
            return []
    
    def get_client_allowed_models(self) -> List[str]:
        """Get models that are allowed to be sent to the server"""
        all_models = self.detect_models()
        
        if self.allowed_models is None:
            # If no filter specified, send all models (original behavior)
            return all_models
        
        # Filter to only include allowed models that are actually available
        allowed_available = [model for model in all_models if model in self.allowed_models]
        
        if len(allowed_available) != len(self.allowed_models):
            missing = set(self.allowed_models) - set(all_models)
            if missing:
                logger.warning(f"Some allowed models are not available in Ollama: {list(missing)}")
        
        logger.info(f"Client-allowed models: {allowed_available}")
        return allowed_available

    def join_pool(self) -> bool:
        """Register this host with the Andy API pool"""
        models = self.get_client_allowed_models()
        
        data = {
            'url': self.ollama_url,
            'name': self.host_name,
            'capabilities': self.capabilities,
            'models': models
        }
        
        try:
            response = requests.post(f"{self.andy_api_url}/api/andy/join_pool", json=data, timeout=10)
            if response.status_code == 200:
                result = response.json()
                self.host_id = result.get('host_id')
                self.registered = True
                logger.info(f"Successfully joined pool with host_id: {self.host_id}")
                return True
            else:
                logger.error(f"Failed to join pool: {response.status_code} - {response.text}")
                return False
        except Exception as e:
            logger.error(f"Error joining pool: {e}")
            return False

    def send_ping(self) -> bool:
        """Send a health ping to maintain pool membership"""
        if not self.registered:
            return False
        
        data = {
            'host_id': self.host_id,
            'url': self.ollama_url,
            'name': self.host_name,
            'models': self.get_client_allowed_models()
        }
        
        try:
            response = requests.post(f"{self.andy_api_url}/api/andy/ping_pool", json=data, timeout=10)
            if response.status_code == 200:
                logger.debug("Ping sent successfully")
                return True
            else:
                logger.warning(f"Ping failed: {response.status_code} - {response.text}")
                return False
        except Exception as e:
            logger.error(f"Error sending ping: {e}")
            return False

    def leave_pool(self) -> bool:
        """Leave the Andy API pool"""
        if not self.registered:
            return True
        
        data = {
            'host_id': self.host_id,
            'url': self.ollama_url
        }
        
        try:
            response = requests.post(f"{self.andy_api_url}/api/andy/leave_pool", json=data, timeout=10)
            if response.status_code == 200:
                logger.info("Successfully left pool")
                self.registered = False
                return True
            else:
                logger.warning(f"Failed to leave pool: {response.status_code} - {response.text}")
                return False
        except Exception as e:
            logger.error(f"Error leaving pool: {e}")
            return False

    def get_pool_status(self) -> Optional[Dict]:
        """Get current pool status"""
        try:
            response = requests.get(f"{self.andy_api_url}/api/andy/pool_status", timeout=10)
            if response.status_code == 200:
                return response.json()
            else:
                logger.error(f"Failed to get pool status: {response.status_code}")
                return None
        except Exception as e:
            logger.error(f"Error getting pool status: {e}")
            return None

    def run_monitoring_loop(self, ping_interval: int = 60):
        """Run continuous monitoring loop"""
        logger.info(f"Starting monitoring loop with {ping_interval}s ping interval")
        
        try:
            while True:
                if not self.send_ping():
                    logger.warning("Ping failed, attempting to rejoin pool...")
                    if not self.join_pool():
                        logger.error("Failed to rejoin pool, will retry in next cycle")
                
                time.sleep(ping_interval)
                
        except KeyboardInterrupt:
            logger.info("Monitoring interrupted by user")
        except Exception as e:
            logger.error(f"Monitoring loop error: {e}")
        finally:
            logger.info("Leaving pool...")
            self.leave_pool()

def main():
    parser = argparse.ArgumentParser(description='Andy API Host Client')
    parser.add_argument('--url', default='http://localhost:11434', 
                       help='Ollama server URL (default: http://localhost:11434)')
    parser.add_argument('--name', required=True, 
                       help='Host name for identification')
    parser.add_argument('--andy-url', default='https://mindcraft.riqvip.dev',
                       help='Andy API base URL (default: https://mindcraft.riqvip.dev)')
    parser.add_argument('--capabilities', nargs='*', default=[],
                       help='Host capabilities (e.g., vision, code, math)')
    parser.add_argument('--allowed-models', nargs='*', default=None,
                       help='Only these models will be sent to the server (if not specified, all models are sent)')
    parser.add_argument('--ping-interval', type=int, default=60,
                       help='Ping interval in seconds (default: 60)')
    parser.add_argument('--once', action='store_true',
                       help='Join pool once and exit (no monitoring loop)')
    parser.add_argument('--status', action='store_true',
                       help='Show pool status and exit')
    parser.add_argument('--leave', action='store_true',
                       help='Leave pool and exit')
    
    args = parser.parse_args()
    
    # Create client
    client = AndyHostClient(
        ollama_url=args.url,
        host_name=args.name,
        andy_api_url=args.andy_url,
        capabilities=args.capabilities,
        allowed_models=args.allowed_models
    )
    
    # Handle different modes
    if args.status:
        status = client.get_pool_status()
        if status:
            print(json.dumps(status, indent=2))
        else:
            sys.exit(1)
        return
    
    if args.leave:
        # For leaving, we need to set a dummy host_id if not registered
        client.host_id = f"host_{args.name}"
        client.registered = True
        if client.leave_pool():
            print("Successfully left pool")
        else:
            print("Failed to leave pool")
            sys.exit(1)
        return
    
    # Join pool
    if not client.join_pool():
        print("Failed to join pool")
        sys.exit(1)
    
    if args.once:
        print(f"Successfully joined pool with host_id: {client.host_id}")
        return
    
    # Run monitoring loop
    client.run_monitoring_loop(args.ping_interval)

if __name__ == '__main__':
    main()
