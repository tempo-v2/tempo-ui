import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { Toast } from "@tempo-v2/core-components";

const NotifyContext = createContext(null);

export function Notifications({ children }) {
  const sequence = useRef(0);
  const [notification, setNotification] = useState(null);
  const notify = useCallback(message => {
    setNotification({ id: ++sequence.current, message });
  }, []);
  const dismiss = useCallback(id => {
    setNotification(current => current?.id === id ? null : current);
  }, []);

  return (
    <NotifyContext.Provider value={notify}>
      {children}
      <Toast notification={notification} onDismiss={dismiss} />
    </NotifyContext.Provider>
  );
}

export function useNotify() {
  return useContext(NotifyContext);
}
