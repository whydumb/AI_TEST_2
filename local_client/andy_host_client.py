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
import threading
import re
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
        self.connection_lock = threading.Lock()
        
        # Cache for models to avoid repeated API calls
        self._cached_models = None
        self._models_cache_time = 0
        self._models_cache_ttl = 300  # Cache models for 5 minutes
        
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
            # Use model_dump() to get dictionary and access 'model' field, not 'name'
            model_names = [model.model_dump()['model'] for model in models.models]
            logger.info(f"Detected {len(model_names)} models: {model_names}")
            return model_names
        except Exception as e:
            logger.error(f"Failed to detect models: {e}")
            return []
    
    def get_client_allowed_models(self) -> List[str]:
        """Get models that are allowed to be sent to the server (with caching)"""
        current_time = time.time()
        
        # Check if we have a valid cache
        if (self._cached_models is not None and 
            current_time - self._models_cache_time < self._models_cache_ttl):
            return self._cached_models
        
        # Cache miss, fetch fresh data
        all_models = self.detect_models()
        
        if self.allowed_models is None:
            # If no filter specified, send all models (original behavior)
            allowed_available = all_models
        else:
            # Filter to only include allowed models that are actually available
            allowed_available = [model for model in all_models if model in self.allowed_models]
            
            if len(allowed_available) != len(self.allowed_models):
                missing = set(self.allowed_models) - set(all_models)
                if missing:
                    logger.warning(f"Some allowed models are not available in Ollama: {list(missing)}")
        
        # Update cache
        self._cached_models = allowed_available
        self._models_cache_time = current_time
        
        logger.info(f"Client-allowed models: {allowed_available}")
        return allowed_available

    def join_pool(self) -> bool:
        """Register this host with the Andy API pool. This should only be called by the connection manager."""
        logger.info("Connection Manager: Attempting to join pool...")
        models = self.get_client_allowed_models()
        if not models:
            logger.warning("Connection Manager: No models available to advertise. Cannot join pool.")
            return False

        data = {
            "info": {
                'url': self.ollama_url,
                'name': self.host_name,
                'capabilities': self.capabilities,
                'models': models
            }
        }
        try:
            response = requests.post(f"{self.andy_api_url}/api/andy/join_pool", json=data, timeout=10)
            if response.status_code == 200:
                result = response.json()
                with self.connection_lock:
                    self.host_id = result.get('host_id')
                    self.registered = True
                logger.info(f"Connection Manager: Successfully joined pool with host_id: {self.host_id}")
                return True
            else:
                logger.error(f"Connection Manager: Failed to join pool: {response.status_code} - {response.text}")
                return False
        except Exception as e:
            logger.error(f"Connection Manager: Error joining pool: {e}")
            return False

    def send_ping(self) -> bool:
        """Send a health ping. This should only be called by the connection manager."""
        with self.connection_lock:
            if not self.registered:
                return False
            host_id = self.host_id
            data = {
                'host_id': host_id,
                'current_load': 0,
                'status': 'active',
                'vram_used_gb': 0,
                'ram_used_gb': 0,
                'cpu_usage_percent': 0
            }

        try:
            response = requests.post(f"{self.andy_api_url}/api/andy/ping_pool", json=data, timeout=10)
            if response.status_code == 200:
                logger.debug("Connection Manager: Ping sent successfully")
                return True

            if response.status_code == 404:
                logger.warning("Connection Manager: Ping failed with 404 (Host Not Found). Verifying for 5s before disconnecting.")
                for i in range(5):
                    time.sleep(1)
                    logger.info(f"Connection Manager: Re-pinging to confirm disconnect... attempt {i+1}/5")
                    try:
                        retry_response = requests.post(f"{self.andy_api_url}/api/andy/ping_pool", json=data, timeout=3)
                        if retry_response.status_code == 200:
                            logger.info("Connection Manager: Re-ping successful. Connection is stable.")
                            return True  # Connection recovered
                    except requests.exceptions.RequestException as e:
                        logger.warning(f"Connection Manager: Re-ping attempt failed: {e}")
                
                logger.error("Connection Manager: Failed to re-establish connection after 5s. Marking as unregistered.")
                with self.connection_lock:
                    if self.host_id == host_id:  # Ensure we don't mess up a new session
                        self.registered = False
                return False
            else:
                logger.warning(f"Connection Manager: Ping failed: {response.status_code} - {response.text}")
                return False
        except Exception as e:
            logger.error(f"Connection Manager: Error sending ping: {e}")
            with self.connection_lock:
                if self.host_id == host_id:
                    self.registered = False
            return False

    def leave_pool(self) -> bool:
        """Leave the Andy API pool"""
        with self.connection_lock:
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
                with self.connection_lock:
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
        """Run continuous monitoring loop with long-polling work processing"""
        logger.info(f"Starting monitoring loop with {ping_interval}s ping interval")
        
        ping_thread = None
        running = True
        
        def ping_worker():
            """Background connection manager: handles joining and pinging."""
            while running:
                with self.connection_lock:
                    is_registered = self.registered

                if is_registered:
                    # If we think we are registered, send a ping.
                    # send_ping will update our status if it gets a 404.
                    self.send_ping()
                else:
                    # If we know we are not registered, try to join.
                    logger.info("Connection manager: Host not registered. Attempting to join pool...")
                    if self.join_pool():
                        logger.info("Connection manager: Successfully joined pool.")
                    else:
                        logger.error("Connection manager: Failed to join pool. Will retry.")
                
                # Wait before next action
                time.sleep(ping_interval)
        
        try:
            # Start connection manager thread
            ping_thread = threading.Thread(target=ping_worker, daemon=True)
            ping_thread.start()
            logger.info("Connection manager thread started")
            
            # Main work polling loop
            while running:
                try:
                    host_id_for_poll = None
                    with self.connection_lock:
                        if self.registered:
                            host_id_for_poll = self.host_id
                    
                    if not host_id_for_poll:
                        logger.debug("Work poller: waiting for registration...")
                        time.sleep(5)
                        continue
                    
                    # Get available models (can be slow, so outside lock)
                    models = self.get_client_allowed_models()
                    
                    if not models:
                        logger.warning("No models available, skipping work poll")
                        time.sleep(10)
                        continue
                    
                    # Poll for work
                    payload = {
                        "host_id": host_id_for_poll,
                        "models": models,
                        "timeout": 30
                    }
                    
                    response = requests.post(
                        f"{self.andy_api_url}/api/andy/poll_for_work",
                        json=payload,
                        timeout=35  # Slightly longer than poll timeout
                    )
                    
                    if response.status_code == 200:
                        work_data = response.json()
                        work_id = work_data.get('work_id')
                        
                        if work_id:
                            logger.info(f"Received work: {work_id} for model {work_data.get('model')}")
                            
                            # Process the work
                            self.process_work(work_id, work_data)
                        
                    elif response.status_code == 204:
                        # No work available, continue polling
                        pass
                    elif response.status_code == 404:
                        logger.warning("Work poll failed: Host not registered (404). Notifying connection manager.")
                        with self.connection_lock:
                            self.registered = False
                        # Give connection manager time to react before we loop again
                        time.sleep(5)
                        continue
                    else:
                        logger.warning(f"Work poll failed: {response.status_code}")
                        time.sleep(5)
                        
                except requests.exceptions.Timeout:
                    # Timeout is expected for long polling
                    pass
                except Exception as e:
                    logger.error(f"Work polling error: {e}", exc_info=True)
                    time.sleep(5)
                
        except KeyboardInterrupt:
            logger.info("Monitoring interrupted by user")
        except Exception as e:
            logger.error(f"Monitoring loop error: {e}", exc_info=True)
        finally:
            running = False
            if ping_thread:
                ping_thread.join(timeout=5)
            logger.info("Leaving pool...")
            self.leave_pool()
    
    def process_work(self, work_id: str, work_data: dict):
        """Process assigned work - supports chat, embedding, and model discovery"""
        try:
            task_type = work_data.get('task_type', 'chat')  # Default to chat for backwards compatibility
            
            if task_type == 'embedding':
                self._process_embedding_work(work_id, work_data)
            elif task_type == 'model_discovery':
                self._process_model_discovery_work(work_id, work_data)
            else:
                # Default chat processing
                self._process_chat_work(work_id, work_data)
                
        except Exception as e:
            logger.error(f"Error processing work {work_id}: {e}")
            # Submit error result
            submit_payload = {
                "work_id": work_id,
                "error": f"Work processing failed: {str(e)}"
            }
            try:
                requests.post(
                    f"{self.andy_api_url}/api/andy/submit_work_result",
                    json=submit_payload,
                    timeout=10
                )
            except Exception as submit_error:
                logger.error(f"Failed to submit error result: {submit_error}")

    def _process_chat_work(self, work_id: str, work_data: dict):
        """Process chat completion work"""
        model = work_data['model']
        messages = work_data['messages']
        params = work_data.get('params', {})
        
        # Make request to local Ollama
        ollama_payload = {
            "model": model,
            "messages": messages,
            "stream": False,
            **params
        }
        
        response = requests.post(
            f"{self.ollama_url}/api/chat",
            json=ollama_payload,
            timeout=120
        )
        
        if response.status_code == 200:
            # Handle Ollama's response format
            try:
                result = response.json()
            except json.JSONDecodeError:
                # Handle streaming format - parse last complete JSON line
                lines = response.text.strip().split('\n')
                for line in reversed(lines):
                    if line.strip():
                        try:
                            result = json.loads(line)
                            break
                        except json.JSONDecodeError:
                            continue
                else:
                    raise ValueError("Could not parse JSON response from Ollama")
            
            # Submit successful result
            submit_payload = {
                "work_id": work_id,
                "result": result
            }
        else:
            # Submit error result
            submit_payload = {
                "work_id": work_id,
                "error": f"Ollama request failed: {response.status_code}"
            }
        
        # Submit result back to server
        submit_response = requests.post(
            f"{self.andy_api_url}/api/andy/submit_work_result",
            json=submit_payload,
            timeout=10
        )
        
        if submit_response.status_code == 200:
            logger.info(f"Successfully submitted result for work {work_id}")
        else:
            logger.error(f"Failed to submit result for work {work_id}: {submit_response.status_code}")

    def _process_embedding_work(self, work_id: str, work_data: dict):
        """Process embedding work"""
        model = work_data['model']
        input_text = work_data['input']
        
        # Make request to local Ollama embeddings endpoint
        ollama_payload = {
            "model": model,
            "prompt": input_text
        }
        
        response = requests.post(
            f"{self.ollama_url}/api/embeddings",
            json=ollama_payload,
            timeout=60
        )
        
        if response.status_code == 200:
            result = response.json()
            embedding = result.get('embedding', [])
            
            if not embedding:
                submit_payload = {
                    "work_id": work_id,
                    "error": "No embedding returned from Ollama"
                }
            else:
                submit_payload = {
                    "work_id": work_id,
                    "result": {"embedding": embedding}
                }
        else:
            submit_payload = {
                "work_id": work_id,
                "error": f"Ollama embedding request failed: {response.status_code}"
            }
        
        # Submit result back to server
        submit_response = requests.post(
            f"{self.andy_api_url}/api/andy/submit_work_result",
            json=submit_payload,
            timeout=10
        )
        
        if submit_response.status_code == 200:
            logger.info(f"Successfully submitted embedding result for work {work_id}")
        else:
            logger.error(f"Failed to submit embedding result for work {work_id}: {submit_response.status_code}")

    def _process_model_discovery_work(self, work_id: str, work_data: dict):
        """Process model discovery work"""
        try:
            # Query Ollama for available models
            response = requests.get(f"{self.ollama_url}/api/tags", timeout=10)
            
            if response.status_code == 200:
                ollama_models = response.json()
                models = ollama_models.get('models', [])
                
                submit_payload = {
                    "work_id": work_id,
                    "result": {"models": models}
                }
            else:
                submit_payload = {
                    "work_id": work_id,
                    "error": f"Failed to query Ollama models: {response.status_code}"
                }
        except Exception as e:
            submit_payload = {
                "work_id": work_id,
                "error": f"Model discovery failed: {str(e)}"
            }
        
        # Submit result back to server
        submit_response = requests.post(
            f"{self.andy_api_url}/api/andy/submit_work_result",
            json=submit_payload,
            timeout=10
        )
        
        if submit_response.status_code == 200:
            logger.info(f"Successfully submitted model discovery result for work {work_id}")
        else:
            logger.error(f"Failed to submit model discovery result for work {work_id}: {submit_response.status_code}")

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
    parser.add_argument('--ping-interval', type=int, default=15,
                       help='Ping interval in seconds (default: 15)')
    parser.add_argument('--once', action='store_true',
                       help='Join pool once and exit (no monitoring loop)')
    parser.add_argument('--status', action='store_true',
                       help='Show pool status and exit')
    parser.add_argument('--leave', action='store_true',
                       help='Leave pool and exit')
    parser.add_argument('--test-auto', action='store_true',
                       help='Run automated join, inference, and connection stability test (auto-mode)')
    parser.add_argument('--test-minutes', type=int, default=2,
                       help='How many minutes to test connection stability (default: 2)')
    
    args = parser.parse_args()
    
    # Create client and start its background connection manager
    client = AndyHostClient(
        ollama_url=args.url,
        host_name=args.name,
        andy_api_url=args.andy_url,
        capabilities=args.capabilities,
        allowed_models=args.allowed_models
    )

    # --- AUTO TEST MODE ---
    if args.test_auto:
        import datetime
        import re
        logger.info("[AUTO-TEST] Starting auto-mode test for model 'sweaterdog/andy-4:micro-q5_k_m'")
        client.allowed_models = ['sweaterdog/andy-4:micro-q5_k_m']
        start_time = datetime.datetime.now()
        join_success = False
        for attempt in range(10):
            logger.info(f"[AUTO-TEST] Attempt {attempt+1} to join pool...")
            if client.join_pool():
                join_success = True
                break
            time.sleep(2)
        if not join_success:
            logger.error("[AUTO-TEST] Failed to join pool after 10 attempts.")
            sys.exit(1)
        logger.info(f"[AUTO-TEST] Successfully joined pool with host_id: {client.host_id}")
        logger.info(f"[AUTO-TEST] Testing connection stability for {args.test_minutes} minutes...")
        stable = True
        for sec in range(args.test_minutes * 60):
            with client.connection_lock:
                if not client.registered:
                    logger.error(f"[AUTO-TEST] Client disconnected at {sec} seconds!")
                    stable = False
                    break
            if sec % 10 == 0:
                logger.info(f"[AUTO-TEST] Still connected at {sec} seconds...")
            time.sleep(1)
        if not stable:
            logger.error("[AUTO-TEST] Connection was not stable for the full duration.")
            sys.exit(1)
        logger.info("[AUTO-TEST] Connection was stable for the full duration.")
        # Inference test
        logger.info("[AUTO-TEST] Sending test inference: wood collection")
        # Simulate a work item as the server would send
        fake_work = {
            'work_id': 'auto-test-1',
            'model': 'sweaterdog/andy-4:micro-q5_k_m',
            'messages': [
                {
                    "role": "user", 
                    "content": "I need to get some wood blocks for building. Help me collect wood."
                }
            ],
            'params': {}
        }
        # Patch process_work to capture output
        result_holder = {}
        def test_process_work(work_id, work_data):
            try:
                model = work_data['model']
                messages = work_data['messages']
                params = work_data.get('params', {})
                ollama_payload = {
                    "model": model,
                    "messages": messages,
                    "stream": False,
                    **params
                }
                response = requests.post(
                    f"{client.ollama_url}/api/chat",
                    json=ollama_payload,
                    timeout=120
                )
                if response.status_code == 200:
                    # Handle Ollama's streaming JSON response format
                    try:
                        result = response.json()
                        logger.info(f"[AUTO-TEST] Inference result: {result}")
                        result_holder['result'] = result
                    except json.JSONDecodeError:
                        # Handle streaming format - parse last complete JSON line
                        lines = response.text.strip().split('\n')
                        for line in reversed(lines):
                            if line.strip():
                                try:
                                    result = json.loads(line)
                                    logger.info(f"[AUTO-TEST] Inference result (from stream): {result}")
                                    result_holder['result'] = result
                                    break
                                except json.JSONDecodeError:
                                    continue
                        else:
                            logger.error(f"[AUTO-TEST] Could not parse any JSON from response: {response.text[:200]}...")
                            result_holder['error'] = "Could not parse JSON response"
                else:
                    logger.error(f"[AUTO-TEST] Ollama request failed: {response.status_code}")
                    result_holder['error'] = f"Ollama request failed: {response.status_code}"
            except Exception as e:
                logger.error(f"[AUTO-TEST] Error in test_process_work: {e}")
                result_holder['error'] = str(e)
        test_process_work('auto-test-1', fake_work)
        if 'result' in result_holder:
            # Check for any command in result (commands start with !)
            response_text = result_holder['result'].get('message', {}).get('content', '')
            logger.info(f"[AUTO-TEST] Model response content: '{response_text}'")
            if re.search(r'![a-zA-Z][a-zA-Z0-9_]*\s*\(', response_text):
                logger.info("[AUTO-TEST] Inference test PASSED: Minecraft command found in response.")
                print("[AUTO-TEST] All tests PASSED.")
                sys.exit(0)
            else:
                logger.error(f"[AUTO-TEST] Inference test FAILED: No Minecraft command found in response: '{response_text}'")
                print(f"[AUTO-TEST] Inference test FAILED: No Minecraft command found in response.")
                sys.exit(2)
        else:
            logger.error(f"[AUTO-TEST] Inference test FAILED: {result_holder.get('error')}")
            print(f"[AUTO-TEST] Inference test FAILED: {result_holder.get('error')}")
            sys.exit(2)
        return
    
    # The monitoring loop is now started by default, and it handles joining.
    # We no longer need a separate join_pool() call here.
    
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
    
    # If --once is specified, we just want to join, print status, and exit.
    # The connection manager will have already tried to join. We wait a moment for it.
    if args.once:
        logger.info("`--once` flag detected. Waiting for initial registration attempt...")
        time.sleep(5) # Give the connection manager a moment to do its first join attempt
        with client.connection_lock:
            if client.registered:
                print(f"Successfully joined pool with host_id: {client.host_id}")
                # We leave immediately as per --once functionality
                client.leave_pool()
            else:
                print("Failed to join pool. Check logs for details.")
                sys.exit(1)
        return

    # Run monitoring loop (which also handles the connection)
    client.run_monitoring_loop(args.ping_interval)

if __name__ == '__main__':
    main()
