import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

let sharedSocket: Socket | null = null;
let refCount = 0;

function getSocket(): Socket {
  if (!sharedSocket) {
    sharedSocket = io({ transports: ['websocket', 'polling'] });
  }
  return sharedSocket;
}

export function useSocket(): Socket {
  const socketRef = useRef<Socket>(getSocket());

  useEffect(() => {
    refCount++;
    if (!socketRef.current.connected) {
      socketRef.current.connect();
    }
    return () => {
      refCount--;
      if (refCount <= 0 && sharedSocket) {
        sharedSocket.disconnect();
        sharedSocket = null;
        refCount = 0;
      }
    };
  }, []);

  return socketRef.current;
}
